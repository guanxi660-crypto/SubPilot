// 快照存储。
//
// 数据模型是「几个数组 + 一份设置」，对外只暴露 loadSnapshot / mutate /
// saveSnapshot 三个操作。**底层驱动是可替换的**：
//
//   · Cloudflare Workers：只有 KV，用下面的 kvDriver —— 整个 snapshot 存一个
//     key，读一次写一次。
//   · Node / Docker：入口注入 env.STORE（SQLite 实现，见 apps/server/node/
//     sqlite-store.mjs）。语义完全相同，但能做到**行级写入** —— 改一条订阅
//     不再把整个数据集重写一遍。
//
// 驱动契约（4 个方法，都是 async）：
//   readSnapshot()      → 快照对象 | null
//   writeSnapshot(snap) → 持久化
//   readStats()         → { items } | null
//   writeStats(stats)   → 持久化
//
// ⚠️ 所有写操作依然直接返回更新后的完整快照（见下），前端用返回值覆盖本地
// 状态。这条约定与驱动无关，换存储时不要动。
//
// 为什么要「单键快照」而不是一开始就分表：数据量天然很小（单用户面板），
// 一次读一次写最省事，也不会出现「订阅写成功、组合没写成功」的中间态。
// 分表是 Node 侧为了写入性能才做的优化，见 sqlite-store.mjs 里的说明。
//
// 后续若要强一致，只需把驱动换成 Durable Object 实现，上层接口不用动。

import { isPlainObject, nowIso } from './util.js';

const SNAPSHOT_KEY = 'panel:snapshot:v1';
const STATS_KEY = 'panel:stats:v1';

/** KV 驱动：整个快照一个 key。Workers 上唯一可用的方案。 */
function kvDriver(DATA) {
    return {
        async readSnapshot() {
            return await DATA.get(SNAPSHOT_KEY, 'json');
        },
        async writeSnapshot(snap) {
            await DATA.put(SNAPSHOT_KEY, JSON.stringify(snap));
        },
        async readStats() {
            return await DATA.get(STATS_KEY, 'json');
        },
        async writeStats(stats) {
            await DATA.put(STATS_KEY, JSON.stringify(stats));
        },
    };
}

/** 取驱动：Node 入口注入的 STORE 优先，否则回落到 KV。 */
function driverOf(env) {
    return env.STORE || kvDriver(env.DATA);
}


export function defaultSettings() {
    return {
        // 转换后端。留空则用 env.SUB_BACKEND（默认 SubConverter-Extended 公共实例）
        subBackend: '',
        // 生成 feed 链接用的对外基地址。留空则取请求来源（生产环境一般无需设置）
        publicBaseUrl: '',
        // 默认目标格式与外部配置
        defaultTarget: 'clash',
        defaultConfig: '',
        // 分发密钥的派生盐。轮换它即可让所有已发出的 /feed、/download 链接立即失效。
        feedSalt: '',
        feedSaltCreatedAt: '',
        // AI 助手（OpenAI 兼容）
        ai: { baseUrl: '', model: '', apiKey: '' },
        // 同步目标
        sync: {
            provider: 'none', // none | gist | webdav
            gist: { token: '', gistId: '' },
            webdav: { url: '', user: '', pass: '', dir: '' },
        },
        // TG 推送。token 是凭据，只在下发时脱敏（见 api.js 的 publicSettings）。
        telegram: {
            token: '',
            chatIds: '',
            targets: [], // [{ kind: 'sub'|'col'|'file', name }]
            linkType: '', // 推送链接的 target，'' = 不指定
            autoPush: false,
            lastPush: null,
        },
    };
}

export function defaultSnapshot() {
    return {
        app: 'SubPilot',
        version: 1,
        // 写次数计数器（审计 L6）。每次 saveSnapshot 自增，用来在排查「改动丢了」
        // 时有据可查：前端 / 日志比对 rev 就能判断两次写是否落在同一份基线上。
        // KV 下它随整个快照一起持久化；SQLite 下存在 meta 行里（见 sqlite-store.mjs）。
        rev: 0,
        subs: [],
        collections: [],
        files: [],
        converted: [],
        shares: [],
        // 自定义算子模板。内置模板是代码常量（operators.js 的 PROCESS_PRESETS），
        // 不落库 —— 落库会和升级后的新内置版本打架（用户那份永远停在旧内容）。
        templates: [],
        settings: defaultSettings(),
        updatedAt: nowIso(),
    };
}

/** 读取快照；缺失/损坏时回落到默认值，不抛异常（面板必须能起来） */
export async function loadSnapshot(env) {
    try {
        const raw = await driverOf(env).readSnapshot();
        if (!isPlainObject(raw)) return defaultSnapshot();
        return normalizeSnapshot(raw);
    } catch {
        return defaultSnapshot();
    }
}

/**
 * 写入冲突（审计 L6）。
 *
 * 由**驱动**在写事务内部抛出：读到的版本号与库里当前版本不一致，说明本次
 * 「读 → 改」期间已经有别的写入落库了 —— 继续写下去就会把那次修改整个盖掉。
 * 抛出来让 mutate 重放一次，比静默 last-write-wins 强得多。
 *
 * KV 驱动没有 CAS 能力，永远不会抛这个（跨 isolate 的一致性只能靠 Durable
 * Object 解决）；SQLite 驱动在 BEGIN IMMEDIATE 事务内比对 meta.rev。
 */
export class ConflictError extends Error {
    constructor(message = '数据在本次操作期间被其他写入修改，请重试') {
        super(message);
        this.name = 'ConflictError';
        this.status = 409;
        this.expose = true;
    }
}

export async function saveSnapshot(env, snap, { expectedRev } = {}) {
    snap.updatedAt = nowIso();
    snap.rev = (Number(snap.rev) || 0) + 1;
    await driverOf(env).writeSnapshot(snap, { expectedRev });
    return snap;
}

/**
 * mutate 的**进程内串行化闸门**（审计 L6）。
 *
 * 为什么必须有：`mutate()` 是「读整份快照 → 回调修改 → 写回整份」，本身没有
 * CAS。同一进程里两个写操作撞上时（典型组合：用户点「保存成品」的同时，
 * Telegram 即时推送正在写 `lastPush`），后写的那份快照是基于**旧**数据算出来的，
 * 会把先写的那次修改整个盖掉 —— 而且不报错，用户只会觉得「刚才那次没保存上」。
 *
 * 串行化之后，「读-改-写」在同一进程内变成原子的。跨进程 / 跨 isolate 的并发
 * （Workers 多 colo、多容器共享一个库）依然无法根治 —— 那需要 Durable Object
 * 或数据库级 CAS；这条链解决的是**实际会撞上**的那部分，成本却只有一行 Promise。
 *
 * ⚠️ 回调里**不能**再调用 `mutate()`，否则会在同一条链上自我等待、永久挂起。
 * 目前所有调用点（api / sync / telegram / templates）都是单层的，没有嵌套。
 */
let mutateChain = Promise.resolve();

/** 写冲突时重放几次。一次就够：串行化之后同进程不会互撞，剩下的是跨进程。 */
const MAX_WRITE_RETRY = 1;

/**
 * 读 → 改 → 写。fn 收到快照，可直接原地修改，也可返回一个值作为 result。
 * 返回 { snap, result }。
 *
 * 回调**只依赖传进来的 snap**，因此写冲突时可以安全重放：重新读一份最新快照
 * 再跑一遍，语义等价于「这次操作发生在更晚的时间点」。
 */
export async function mutate(env, fn) {
    const run = async () => {
        for (let attempt = 0; ; attempt++) {
            const snap = await loadSnapshot(env);
            const baseRev = Number(snap.rev) || 0;
            const result = await fn(snap);
            try {
                await saveSnapshot(env, snap, { expectedRev: baseRev });
                return { snap, result };
            } catch (e) {
                if (e?.name !== 'ConflictError' || attempt >= MAX_WRITE_RETRY) throw e;
            }
        }
    };
    // 前一步失败也要继续排下一步，否则一次失败会把整条链永久卡死
    const next = mutateChain.then(run, run);
    mutateChain = next.then(
        () => {},
        () => {},
    );
    return next;
}

function normalizeSnapshot(raw) {
    const base = defaultSnapshot();
    const out = { ...base, ...raw };
    for (const k of ['subs', 'collections', 'files', 'converted', 'shares', 'templates']) {
        if (!Array.isArray(out[k])) out[k] = [];
    }
    // 老快照里没有 rev；被手工改过的备份里可能是字符串 / NaN —— 一律收敛成有限数
    out.rev = Number.isFinite(Number(out.rev)) ? Number(out.rev) : 0;
    out.settings = { ...defaultSettings(), ...(isPlainObject(raw.settings) ? raw.settings : {}) };
    out.settings.ai = { ...defaultSettings().ai, ...(raw.settings?.ai || {}) };
    out.settings.sync = { ...defaultSettings().sync, ...(raw.settings?.sync || {}) };
    out.settings.sync.gist = {
        ...defaultSettings().sync.gist,
        ...(raw.settings?.sync?.gist || {}),
    };
    out.settings.sync.webdav = {
        ...defaultSettings().sync.webdav,
        ...(raw.settings?.sync?.webdav || {}),
    };
    out.settings.telegram = {
        ...defaultSettings().telegram,
        ...(raw.settings?.telegram || {}),
    };
    if (!Array.isArray(out.settings.telegram.targets)) out.settings.telegram.targets = [];
    return out;
}

// ---- 拉取统计 ----

/**
 * 统计条目上限（审计 M5）。
 *
 * key 是 `类型|项目|IP` —— 每个拉取过订阅的客户端 IP 都会留下一条**永久**记录，
 * 只有手工 `DELETE /api/stats` 才清。Cloudflare KV 单个 value 上限 25MiB，
 * 逼近之后 `writeStats` 抛错、此前又被 `waitUntil(...).catch(() => {})` 静默吞掉，
 * 用户看到的现象是「统计数字不涨了」而不是任何报错，排查时完全无从下手。
 */
export const MAX_STATS_ITEMS = 5000;
/** 触发淘汰后一次降到这个水位：避免每条新记录都跑一次全量排序（摊销到 ~500 次一条） */
const STATS_LOW_WATER = 4500;

export async function loadStats(env) {
    try {
        const raw = await driverOf(env).readStats();
        if (!isPlainObject(raw) || !isPlainObject(raw.items)) return { items: {} };
        return raw;
    } catch {
        return { items: {} };
    }
}

/**
 * 统计写入的串行化闸门。
 *
 * KV 没有原子的「读-改-写」—— 两个请求同时进来，后写的那个会盖掉前一个的计数。
 * 跨 colo 的并发无法根治（那需要 Durable Object），但**同一个 isolate 内**串行化
 * 就能挡掉绝大部分丢计数：一次请求里连着记几次、或自动推送连着触发，
 * 都跑在同一条 Promise 链上。
 *
 * Node / Docker 下 SQLite 驱动虽然能做到单行 UPSERT，但这里仍然保留这条链：
 * 一是行为与 Workers 一致，二是「先读后写」的读-改-写模式本来就需要串行。
 */
let statsChain = Promise.resolve();

/**
 * 记一次拉取。key = `类型|项目|IP`，同 key 累加次数。
 * 统计失败绝不能影响分发本身 —— 调用方用 waitUntil 包住即可。
 */
export async function recordPull(env, { type, item, ip }) {
    const run = async () => {
        const stats = await loadStats(env);
        const key = `${type}|${item}|${ip}`;
        const cur = stats.items[key] || { type, item, ip, count: 0, last: '' };
        cur.count += 1;
        cur.last = nowIso();
        stats.items[key] = cur;

        // 条目上限与轮转（审计 M5）。按 `last` 淘汰最旧的一批；`last` 是 ISO 串，
        // 字典序即时间序，不用解析成 Date。淘汰数量累计到 stats.dropped，
        // 让「记录被裁剪过」在概览页上可见 —— 静默丢数据比丢数据更糟。
        const keys = Object.keys(stats.items);
        if (keys.length > MAX_STATS_ITEMS) {
            const oldestFirst = keys
                .map((k) => [k, String(stats.items[k]?.last || '')])
                .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
            const dropCount = keys.length - STATS_LOW_WATER;
            for (let i = 0; i < dropCount; i++) delete stats.items[oldestFirst[i][0]];
            stats.dropped = (Number(stats.dropped) || 0) + dropCount;
        }

        try {
            await driverOf(env).writeStats(stats);
        } catch (e) {
            // 这里原来是彻底静默的：写失败连一条日志都没有，问题只表现为
            // 「统计数字不动了」（审计 M5）。记一条 warn 再抛，让上层原有的
            // .catch(() => {}) 继续兜住 —— 统计失败绝不能影响分发本身。
            console.warn(`[stats] 写入失败，本次计数已丢弃：${e?.message || e}`);
            throw e;
        }
        return cur;
    };
    // 前一步失败也要继续排下一步，否则一次失败会把整条链永久卡死
    const next = statsChain.then(run, run);
    statsChain = next.catch(() => {});
    return next;
}

export async function clearStats(env) {
    await driverOf(env).writeStats({ items: {} });
}
