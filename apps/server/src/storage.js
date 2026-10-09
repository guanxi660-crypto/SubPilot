// KV 快照存储。
//
// 为什么用「单键快照」而不是每个订阅一个键：
//   数据模型天然是几个数组，一次读一次写最省事，也不会出现「订阅写成功、
//   组合没写成功」的中间态。单用户面板的数据量（几百 KB 上限）对 KV 完全够用。
//
// ⚠️ KV 是最终一致的（跨 colo 传播最长约 60s）。应对办法不是加锁，而是：
//   所有**写操作直接返回更新后的完整快照**，前端用返回值覆盖本地状态。
//   这样「自己刚写完立刻读」永远不会读到旧值。只有换设备/换 colo 才可能短暂看到旧数据。
//
// 后续若要强一致，只需把 loadSnapshot/saveSnapshot 换成 Durable Object 实现，
// 上层的 mutate() 接口不用动。

import { isPlainObject, nowIso } from './util.js';

const SNAPSHOT_KEY = 'panel:snapshot:v1';
const STATS_KEY = 'panel:stats:v1';

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
        const raw = await env.DATA.get(SNAPSHOT_KEY, 'json');
        if (!isPlainObject(raw)) return defaultSnapshot();
        return normalizeSnapshot(raw);
    } catch {
        return defaultSnapshot();
    }
}

export async function saveSnapshot(env, snap) {
    snap.updatedAt = nowIso();
    await env.DATA.put(SNAPSHOT_KEY, JSON.stringify(snap));
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
        const raw = await env.DATA.get(STATS_KEY, 'json');
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
        await env.DATA.put(STATS_KEY, JSON.stringify(stats));
        return cur;
    };
    // 前一步失败也要继续排下一步，否则一次失败会把整条链永久卡死
    const next = statsChain.then(run, run);
    statsChain = next.catch(() => {});
    return next;
}

export async function clearStats(env) {
    await env.DATA.put(STATS_KEY, JSON.stringify({ items: {} }));
}
