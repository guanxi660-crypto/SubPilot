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

export async function saveSnapshot(env, snap) {
    snap.updatedAt = nowIso();
    await driverOf(env).writeSnapshot(snap);
    return snap;
}

/**
 * 读 → 改 → 写。fn 收到快照，可直接原地修改，也可返回一个值作为 result。
 * 返回 { snap, result }。
 */
export async function mutate(env, fn) {
    const snap = await loadSnapshot(env);
    const result = await fn(snap);
    await saveSnapshot(env, snap);
    return { snap, result };
}

function normalizeSnapshot(raw) {
    const base = defaultSnapshot();
    const out = { ...base, ...raw };
    for (const k of ['subs', 'collections', 'files', 'converted', 'shares', 'templates']) {
        if (!Array.isArray(out[k])) out[k] = [];
    }
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
        await driverOf(env).writeStats(stats);
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
