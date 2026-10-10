// 分发与转换路由：/sub、/download/*、/feed/*、/share/*、/healthz
//
// 处理链（这是整个项目的中枢）：
//
//   客户端 ──► Worker /download/<订阅>
//                 │
//                 ├─ 无算子 ──► 直接把原始订阅 URL 交给 SCE（保留 Provider 模式）
//                 │
//                 └─ 有算子 ──► 取源 → 解析 → JSON 算子 → /feed/<订阅>（可被 SCE 拉取）
//                                                    │
//                                                    └──► SCE /sub?url=<feed>
//                 │
//                 └──► 把 SCE 的响应原样代理回去（保留 Content-Type / 流量信息头）
//
// 为什么「有算子」时不直接内联内容给 SCE：SCE 的 url 参数只接受 URL 或
// `node:` 前缀的 HTTP 代理链接（见其 interfaces.cpp 的 parseTaggedLink），
// 没有内联节点列表的入口。所以走 /feed 中转。
//
// 鉴权（重要）：/feed 与 /download 的地址会被写进客户端配置并长期使用，
// 因此它们**不接受管理令牌以外的唯一方式** —— 优先用 HMAC 派生的只读分发密钥
// （?ft=），见 feedkey.js 的说明。管理令牌仍然可用（方便排障）。

import { safeEqual, b64decode, b64encode, b64urlEncode, ok, fail, text, toStringArray, isPlainObject } from './util.js';
import { loadSnapshot, recordPull, mutate } from './storage.js';
import { resolveBackend, callSce, describeSceError } from './sce.js';
import { runPipeline, stripRefPrefix } from './pipeline.js';
import { serializeNodes } from './nodes.js';
import { deriveFeedKey, ensureFeedSalt, checkFeedKey } from './feedkey.js';

/** 对外基地址：优先用设置里的 publicBaseUrl，否则取请求来源 */
export function publicBase(request, settings) {
    const configured = String(settings?.publicBaseUrl || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
}

function clientIp(request) {
    return (
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Real-IP') ||
        (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
        'local'
    );
}

function extractParams(query) {
    const p = {};
    for (const [k, v] of query.entries()) p[k] = v;
    return p;
}

/** 短哈希，用于给 adhoc feed 派生稳定的分发密钥 */
function shortHash(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        h1 ^= s.charCodeAt(i);
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b) + i) >>> 0;
    }
    return (h1.toString(16) + h2.toString(16)).padStart(16, '0').slice(0, 16);
}

/**
 * 统一的分发鉴权。三条通道，任一通过即可：
 *   ① 管理令牌（?token= 或 Bearer）—— 全权限，用于排障
 *   ② 分享码（?code=）—— 只读、限时、限资源
 *   ③ 派生分发密钥（?ft=）—— 只读、限资源、不过期，是正常分发用的通道
 */
async function authorizeDistribution(env, snap, query, { kind, name, tokenFromAuth }) {
    const expected = String(env.SUBPILOT_TOKEN || '');
    if (expected && tokenFromAuth && safeEqual(tokenFromAuth, expected)) {
        return { ok: true, mode: 'admin' };
    }
    const code = query.get('code') || '';
    if (code) {
        const sh = snap.shares.find((s) => s.code === code);
        if (
            sh &&
            (!sh.expiresAt || new Date(sh.expiresAt).getTime() > Date.now()) &&
            sh.type === kind &&
            sh.name === name
        ) {
            return { ok: true, mode: 'share' };
        }
    }
    const ft = query.get('ft') || '';
    if (ft && (await checkFeedKey(env, snap.settings, kind, name, ft))) {
        return { ok: true, mode: 'feedkey' };
    }
    return { ok: false, mode: '' };
}

/**
 * 决定这次请求要不要本地处理节点。
 * 触发条件：显式传了 process / 引用了带算子的订阅或组合 / 来源里有本地内容。
 */
function needsLocalProcessing({ sources, process, sub, collection }) {
    if (Array.isArray(process) && process.length) return true;
    if (sources.some((s) => Array.isArray(s.process) && s.process.length)) return true;
    if (sources.some((s) => s.kind === 'local')) return true;
    if (sub && sub.source === 'local') return true;
    return false;
}

/**
 * 把 source 列表折成 adhoc spec（多来源分发的唯一寻址载体）。
 *
 * ⚠️ `process` 必须**逐条**带上。spec 是唯一穿过 URL 的东西 —— 少了它，
 * /feed/adhoc → runPipeline 里 `item.process` 就是空的，每条订阅自己的 JSON 脚本
 * 会被静默跳过（没有报错，只是节点没被筛选 / 改名 / 排序），
 * 表现成「多选的时候脚本好像没生效」，非常难往 spec 上想。
 */
export function adhocSpec(sources, process) {
    return {
        sources: sources.map((s) => ({
            ref: s.ref,
            ua: s.ua || '',
            process: Array.isArray(s.process) ? s.process : [],
        })),
        process: Array.isArray(process) ? process : [],
    };
}

/**
 * 把一串「来源引用」解析成 pipeline 能吃的 source 列表。
 *
 * 每一项可能是：已存订阅名、sp://<名称> 显式引用（也认旧前缀 spx://）、或一个裸 URL。
 * ⚠️ 必须在这里就把站内订阅解析出来并带上它的 process / 本地标记 ——
 * 只塞一个 { ref } 进去会让下游两处判断全部失灵：
 *   · needsLocalProcessing 看不到 sources[].process 和 kind:'local'，误判为「无需本地处理」；
 *   · 直连分支拿 s.ref 去 snap.subs 里查（查不到，名字还带着 sp:// 前缀），
 *     于是把 "sp://演示机场 A" 原样当成 URL 丢给 SCE。
 * 症状就是**多选站内订阅必定 400**（no valid proxy nodes or remote resources）。
 *
 * 前缀规则与 pipeline.js 的 resolveSource 保持一致 —— 统一走 stripRefPrefix，
 * 两边不能各写一套（偏移写死过一次，见 pipeline.js 里那段说明）。
 */
export function resolveSourceRefs(snap, list) {
    const out = [];
    for (const ref of toStringArray(list)) {
        const raw = String(ref || '').trim();
        if (!raw) continue;
        const explicit = stripRefPrefix(raw);
        const guess = explicit !== null ? explicit : /^https?:\/\//i.test(raw) ? '' : raw;
        const stored = guess ? snap.subs.find((s) => s.name === guess) : null;
        if (stored) {
            out.push({
                ref: stored.name,
                process: stored.process || [],
                kind: stored.source === 'local' ? 'local' : '',
            });
        } else {
            out.push({ ref: raw });
        }
    }
    return out;
}

// ---- SCE 扩展来源语法（对齐 Aethersailor/subweb 前端的 source-modifiers）----
// 每条来源可写成 `tag:标签,provider:名称,URL`，多条来源用 | 连成**一条** url 参数。
// SCE 据此为每条远程订阅生成**独立命名**的 proxy-provider（zashboard 按名字管理）。
//
// 只对「客户端自拉」模式的 target 生效。2026-10-09 裁剪目标格式后只剩 clash
// 一个 Provider 格式，其余（singbox 等）会把前缀当成 URL 的一部分，必须原样返回。
const SCE_PREFIX_TARGETS = new Set(['clash']);

/** tag/provider 值不能含逗号、竖线或换行 —— 会破坏 `tag:x,provider:y,url` 的片段结构 */
function sanitizePrefixValue(v) {
    return String(v || '').replace(/[,|\r\n]/g, ' ').trim();
}

/** 来源的显示名：站内订阅用显示名/名称；裸 URL 用主机名 */
function sourceLabel(snap, ref) {
    const stored = snap.subs.find((x) => x.name === ref);
    if (stored) return stored.displayName || stored.name || '';
    try {
        return new URL(ref).hostname;
    } catch {
        return '';
    }
}

/**
 * 给一条来源 URL 包上 SCE 扩展前缀。
 * 仅在**多来源**递交时使用：单来源没有命名必要（就一个 provider）。
 * 不支持该语法的 target（如 singbox）原样返回 —— SCE 会把前缀当成 URL 的一部分。
 */
function decorateSourceUrl(url, label, target) {
    const base = String(target || '').split('&')[0].toLowerCase();
    if (!SCE_PREFIX_TARGETS.has(base)) return url;
    const tag = sanitizePrefixValue(label);
    if (!tag) return url;
    return `tag:${tag},provider:${tag},${url}`;
}

/** 取（必要时创建）分发盐，保证 feed 密钥可用 */
async function feedSaltOf(env, snap) {
    if (snap.settings.feedSalt) return snap.settings.feedSalt;
    const { result } = await ensureFeedSalt(env, mutate);
    snap.settings.feedSalt = result;
    return result;
}

/**
 * 构造「SCE 能拉的」feed 地址。
 * 三条路径都是**确定性**的：同样的订阅 + 同样的算子 → 同样的 URL，
 * 这样 Provider 模式下客户端反复拉取不会每次换地址。
 */
async function buildFeedUrl(env, snap, { base, sub, collection, adhoc }) {
    await feedSaltOf(env, snap);
    if (sub) {
        const ft = await deriveFeedKey(env, snap.settings, 'sub', sub);
        return `${base}/feed/sub/${encodeURIComponent(sub)}?ft=${ft}`;
    }
    if (collection) {
        const ft = await deriveFeedKey(env, snap.settings, 'col', collection);
        return `${base}/feed/col/${encodeURIComponent(collection)}?ft=${ft}`;
    }
    if (adhoc) {
        const spec = b64urlEncode(JSON.stringify(adhoc));
        const ft = await deriveFeedKey(env, snap.settings, 'adhoc', shortHash(spec));
        return `${base}/feed/adhoc?spec=${spec}&ft=${ft}`;
    }
    return '';
}

// ---------------------------------------------------------------- /sub

/**
 * 主转换端点。参数与 SCE 的 /sub 基本一致，额外支持：
 *   sub=<订阅名>        引用本站订阅
 *   collection=<组合名>  引用本站组合
 *   process=<base64>    临时算子链（JSON 数组的 base64）
 *   direct=1            强制不本地处理，原样交给 SCE
 */
export async function handleSub(request, env, ctx, { query, method, tokenFromAuth }) {
    const snap = await loadSnapshot(env);
    const base = resolveBackend(env, snap.settings);
    const params = extractParams(query);

    // ---- 解析来源 ----
    let sub = null;
    let collection = null;
    const sources = [];
    let process = [];

    if (params.sub) {
        sub = snap.subs.find((s) => s.name === params.sub);
        if (!sub) return fail(`订阅不存在：${params.sub}`, 404);
        sources.push({ ref: sub.name, process: sub.process || [] });
    } else if (params.collection) {
        collection = snap.collections.find((c) => c.name === params.collection);
        if (!collection) return fail(`组合不存在：${params.collection}`, 404);
        for (const n of collection.subscriptions || []) {
            const s = snap.subs.find((x) => x.name === n);
            if (s)
                sources.push({
                    ref: s.name,
                    process: s.process || [],
                    // ⚠️ kind 必须带上：needsLocalProcessing 靠它认出「组合里有本地内容订阅」。
                    // 漏了它组合会被误判为直连，本地内容没法交给 SCE，直接 400
                    // （「是本地内容，必须走本地处理」——可用户根本没传 direct=1）。
                    kind: s.source === 'local' ? 'local' : '',
                });
        }
        process = collection.process || [];
    } else if (params.url) {
        sources.push(...resolveSourceRefs(snap, params.url));
    }

    if (params.process) {
        try {
            const parsed = JSON.parse(b64decode(params.process));
            if (Array.isArray(parsed)) process = parsed;
        } catch {
            return fail('process 参数不是合法的 base64 JSON 数组', 400);
        }
    }

    if (!sources.length) {
        return fail('缺少来源：请提供 url、sub 或 collection 参数', 400);
    }

    // ---- raw 通道：编辑后的订阅（Sub-Store 模式），完全不经过 SCE ----
    // 分发/分享链接输出的就是**编辑后的节点本身**：URI 来源 → v2ray base64
    // URI 列表（通用订阅，各客户端直接导入、当转换输入也不会二次转换翻车）；
    // clash 来源 → 本地序列化的 clash YAML（stringifyYaml，同样不经 SCE）。
    // ?target=xxx 在分发通道被忽略 —— SCE 实时转换只保留给转换页（/sub
    // 显式 target）与「保存成品」（/api/converted），分享链接永远不转换。
    if (params.target === 'raw') {
        let result;
        try {
            result = await runPipeline(env, snap, { sources, process });
        } catch (e) {
            return fail(`节点处理失败：${e.message || e}`, 500);
        }

        if (!result.nodes.length) return fail('来源没有可分发的节点', 404);

        // 有 URI 载体就输出通用订阅（clash 形态节点混在里面出不了 URI，
        // 会被 serializeNodes 的 filter(Boolean) 掉 —— 数量头按实际输出计）；
        // 全是 clash 形态（没有 URI 载体）就本地产 clash YAML。
        const uriNodes = result.nodes.filter((n) => n.raw);
        if (uriNodes.length) {
            return text(serializeNodes(result.nodes, 'uri'), 200, 'text/plain;charset=UTF-8', {
                'Cache-Control': 'no-store',
                'X-SubPilot-Nodes': String(uriNodes.length),
                'X-SubPilot-Format': 'uri',
                'Access-Control-Allow-Origin': '*',
            });
        }
        return text(serializeNodes(result.nodes, 'clash'), 200, 'text/yaml;charset=UTF-8', {
            'Cache-Control': 'no-store',
            'X-SubPilot-Nodes': String(result.nodes.length),
            'X-SubPilot-Format': 'clash',
            'Access-Control-Allow-Origin': '*',
        });
    }

    const forceDirect = params.direct === '1' || params.direct === 'true';
    const local = !forceDirect && needsLocalProcessing({ sources, process, sub, collection });

    // ---- 组装给 SCE 的参数 ----
    const sceParams = { ...params };
    delete sceParams.sub;
    delete sceParams.collection;
    delete sceParams.process;
    delete sceParams.direct;
    delete sceParams.token;
    delete sceParams.ft;

    // 默认 target 提前确定 —— 多来源逐条递交时要按 target 判断能不能带 tag:/provider: 前缀
    if (!sceParams.target) sceParams.target = snap.settings.defaultTarget || 'clash';
    if (!sceParams.config && snap.settings.defaultConfig) sceParams.config = snap.settings.defaultConfig;

    if (local) {
        if (!sub && !collection && sources.length > 1 && !(Array.isArray(process) && process.length)) {
            // ---- 多来源逐条递交（subweb 同款行为）----
            // 每条来源各自折一个 adhoc feed（各自算子在 spec 里，逐条分行分条解析发生在
            // 本站 pipeline），再以 tag:/provider: 前缀把全部 feed 连成**一条** url 递给 SCE ——
            // 后端为每条来源生成一个独立命名的 provider（zashboard 里好管理）。
            const parts = [];
            for (const s of sources) {
                const feedUrl = await buildFeedUrl(env, snap, {
                    base: publicBase(request, snap.settings),
                    adhoc: adhocSpec([s], []),
                });
                if (feedUrl.length > 4000) {
                    return fail(
                        '算子链过长，生成的 feed 地址超过 4000 字符。请精简算子，或把它保存为订阅后再分发。',
                        400,
                    );
                }
                parts.push(decorateSourceUrl(feedUrl, sourceLabel(snap, s.ref), sceParams.target));
            }
            sceParams.url = parts.join('|');
        } else {
            // 单订阅 / 组合 / 显式带组合层算子：单条 feed（合并语义，一个 provider）
            const adhoc = sub || collection ? null : adhocSpec(sources, process);
            const feedUrl = await buildFeedUrl(env, snap, {
                base: publicBase(request, snap.settings),
                sub: sub?.name,
                collection: collection?.name,
                adhoc,
            });
            if (feedUrl.length > 4000) {
                return fail(
                    '算子链过长，生成的 feed 地址超过 4000 字符。请精简算子，或把它保存为订阅后再分发。',
                    400,
                );
            }
            sceParams.url = feedUrl;
        }
    } else {
        // 不本地处理：把原始地址交给 SCE，保留它的 Provider / 原生远程资源模式。
        // 多来源时逐条带上 tag:/provider: 前缀（显示名作 provider 名）——
        // 否则 SCE 生成的 provider 是无名的，zashboard 里分不清哪条是哪条。
        const multi = sources.length > 1;
        const urls = [];
        for (const s of sources) {
            const stored = snap.subs.find((x) => x.name === s.ref);
            if (stored) {
                if (stored.source === 'local') {
                    return fail(`订阅「${stored.name}」是本地内容，必须走本地处理（请去掉 direct=1）`, 400);
                }
                for (const u of toStringArray(stored.url)) {
                    urls.push(multi ? decorateSourceUrl(u, sourceLabel(snap, s.ref), sceParams.target) : u);
                }
            } else {
                urls.push(multi ? decorateSourceUrl(s.ref, sourceLabel(snap, s.ref), sceParams.target) : s.ref);
            }
        }
        sceParams.url = urls.join('|');
    }

    // ---- 调用 SCE 并代理响应 ----
    try {
        const res = await callSce(base, sceParams, {
            timeoutMs: 25000,
            method: method === 'HEAD' ? 'HEAD' : 'GET',
            extraHeaders: pickForwardHeaders(request),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return fail(describeSceError(res.status, body), res.status === 400 ? 400 : 502);
        }
        return proxyResponse(res, { local, base });
    } catch (e) {
        return fail(`调用转换后端失败：${e.message || e}`, 502);
    }
}

/** 透传少量对 SCE 有意义的请求头（provider_headers 会用到） */
function pickForwardHeaders(request) {
    const out = {};
    for (const h of ['X-Subscription-Token', 'X-Client-Class']) {
        const v = request.headers.get(h);
        if (v) out[h] = v;
    }
    return out;
}

function proxyResponse(res, meta = {}) {
    const headers = new Headers();
    for (const h of [
        'Content-Type',
        'Content-Disposition',
        'Subscription-UserInfo',
        'Cache-Control',
        'Pragma',
        'Vary',
        'X-Request-ID',
    ]) {
        const v = res.headers.get(h);
        if (v) headers.set(h, v);
    }
    headers.set('X-SubPilot-Processed', meta.local ? 'local' : 'passthrough');
    headers.set('X-SubPilot-Backend', meta.base || '');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------- /feed

/**
 * SCE / 客户端从这里拉处理后的节点。
 * 鉴权见 authorizeDistribution：分发密钥 / 分享码 / 管理令牌。
 */
export async function handleFeed(request, env, ctx, { path, query, tokenFromAuth }) {
    const seg = path.replace(/^\/feed\/?/, '').split('/').filter(Boolean);
    const kind = seg[0];
    const name = seg[1] ? decodeURIComponent(seg[1]) : '';
    const specRaw = query.get('spec') || '';
    // adhoc 的密钥按 spec 的短哈希派生，和 buildFeedUrl 保持一致
    const keyName = kind === 'adhoc' ? shortHash(specRaw) : name;

    const snap = await loadSnapshot(env);
    const auth = await authorizeDistribution(env, snap, query, {
        kind,
        name: keyName,
        tokenFromAuth,
    });
    if (!auth.ok) return fail('分发链接无效或已过期', 403);

    let result;
    try {
        if (kind === 'sub') {
            const sub = snap.subs.find((s) => s.name === name);
            if (!sub) return fail(`订阅不存在：${name}`, 404);
            result = await runPipeline(env, snap, {
                sources: [{ ref: sub.name, process: sub.process || [] }],
            });
        } else if (kind === 'col') {
            const col = snap.collections.find((c) => c.name === name);
            if (!col) return fail(`组合不存在：${name}`, 404);
            const sources = (col.subscriptions || []).map((n) => {
                const s = snap.subs.find((x) => x.name === n);
                return { ref: n, process: s?.process || [] };
            });
            result = await runPipeline(env, snap, { sources, process: col.process || [] });
        } else if (kind === 'adhoc') {
            const spec = JSON.parse(b64decode(specRaw) || '{}');
            if (!isPlainObject(spec)) return fail('spec 参数非法', 400);
            result = await runPipeline(env, snap, {
                sources: Array.isArray(spec.sources) ? spec.sources : [],
                process: Array.isArray(spec.process) ? spec.process : [],
            });
        } else {
            return fail('未知的 feed 类型', 404);
        }
    } catch (e) {
        return fail(`节点处理失败：${e.message || e}`, 500);
    }

    const isClash = result.format === 'clash';
    return text(result.text, 200, isClash ? 'text/yaml;charset=UTF-8' : 'text/plain;charset=UTF-8', {
        'Cache-Control': 'no-store',
        'X-SubPilot-Nodes': String(result.nodes.length),
        'X-SubPilot-Format': result.format,
        'Access-Control-Allow-Origin': '*',
    });
}

// ---------------------------------------------------------------- /download

export async function handleDownload(request, env, ctx, { path, query, method, tokenFromAuth }) {
    const seg = path.replace(/^\/download\/?/, '').split('/').filter(Boolean);
    const isCollection = seg[0] === 'collection';
    // 多来源：前端在转换页临时勾选了多个订阅 / 组合 / 外部地址时，这组选择
    // **没有名字可以寻址**（不是某一条订阅，也不是某个组合），所以用 base64 的 spec 承载，
    // 密钥按 spec 的短哈希派生 —— 和 /feed/adhoc 完全同一套，两边能互相校验。
    // 没有这条通道的话，多选场景根本拿不到「不含管理令牌」的分发链接，
    // 用户只能拿到带 token 的预览链接，等于没法发出去。
    const isAdhoc = seg[0] === 'adhoc';
    const specRaw = isAdhoc ? query.get('spec') || '' : '';
    const name = isAdhoc
        ? shortHash(specRaw)
        : decodeURIComponent(isCollection ? seg[1] || '' : seg[0] || '');
    if (!name) return fail('缺少名称', 400);

    const snap = await loadSnapshot(env);
    const auth = await authorizeDistribution(env, snap, query, {
        kind: isAdhoc ? 'adhoc' : isCollection ? 'col' : 'sub',
        name,
        tokenFromAuth,
    });
    if (!auth.ok) return fail('分发链接无效或已过期', 403);

    const q = new URLSearchParams(query);
    q.delete('token');
    q.delete('ft');
    q.delete('code');
    q.delete('spec');

    let pullName = name;
    if (isAdhoc) {
        let spec;
        try {
            spec = JSON.parse(b64decode(specRaw) || '{}');
        } catch {
            return fail('spec 参数非法', 400);
        }
        if (!isPlainObject(spec)) return fail('spec 参数非法', 400);
        const refs = (Array.isArray(spec.sources) ? spec.sources : [])
            .map((s) => String(s?.ref || '').trim())
            .filter(Boolean);
        if (!refs.length) return fail('spec 里没有任何来源', 400);
        // 交回 handleSub 统一解析来源 —— sp:// 前缀、本地内容、算子链都在那边处理，
        // 这里再实现一遍只会多出一份会走样的副本。
        q.set('url', refs.join('|'));
        if (Array.isArray(spec.process) && spec.process.length) {
            q.set('process', b64encode(JSON.stringify(spec.process)));
        }
        // 统计里显示成「多来源 · 3 项」比一串哈希好认
        pullName = `多来源 · ${refs.length} 项`;
    } else if (isCollection) {
        q.set('collection', name);
    } else {
        q.set('sub', name);
    }

    // 分发通道 = 编辑后的订阅（Sub-Store 模式），**target 参数一律忽略**
    //（无条件覆盖，老链接带 ?target=clash 也输出未转换内容）。此前默认走
    // SCE 转换 —— 分享出去的是转换后配置，被下游当订阅源再转一次（二次
    // 转换）解析不出节点，这也是多客户端分享支持被砍掉的根因。现在分发
    // 链接只产出本地 pipeline 的编辑结果：URI 来源 → base64 URI 列表，
    // clash 来源 → 本地 clash YAML（见 handleSub raw 分支）。要特定客户端
    // 的转换格式请走转换页（/sub?target=xxx 或「保存成品」）。
    q.set('target', 'raw');

    const res = await handleSub(request, env, ctx, { query: q, method, tokenFromAuth });

    // 统计只记成功分发（失败也记的话会污染「拉取次数」这个指标）
    if (res.ok && ctx?.waitUntil) {
        ctx.waitUntil(
            recordPull(env, {
                type: isAdhoc ? '分发多来源' : isCollection ? '组合' : '订阅',
                item: pullName,
                ip: clientIp(request),
            }).catch(() => {}),
        );
    }
    return res;
}

// ---------------------------------------------------------------- /share

/** 目标格式 → 成品的 Content-Type（只影响「浏览器直接打开」的观感与少数客户端的嗅探） */
const YAML_TARGETS = new Set(['clash']);
const JSON_TARGETS = new Set(['singbox']);

function contentTypeForTarget(target) {
    const t = String(target || '').toLowerCase();
    if (YAML_TARGETS.has(t)) return 'text/yaml;charset=UTF-8';
    if (JSON_TARGETS.has(t)) return 'application/json;charset=UTF-8';
    // 其余（shadowrocket / vless / ss 等 base64 或明文订阅）本来就是纯文本，也给 text/plain ——
    // 订阅类客户端对它的兼容性最好，拿不准就别自作聪明。
    return 'text/plain;charset=UTF-8';
}

export function validateShare(snap, code) {
    const sh = snap.shares.find((s) => s.code === code);
    if (!sh) return { error: '分享码无效或已被删除' };
    if (sh.expiresAt && new Date(sh.expiresAt).getTime() < Date.now()) {
        return { error: '分享码已过期' };
    }
    return { share: sh };
}

export async function handleShare(request, env, ctx, { path, query, method }) {
    const seg = path.replace(/^\/share\/?/, '').split('/').filter(Boolean);
    const kind = seg[0];
    const name = seg[1] ? decodeURIComponent(seg[1]) : '';
    const code = query.get('code') || '';

    // 统一 403：不区分「不存在 / 已过期 / 类型不匹配」，避免泄露资源是否存在
    const snap = await loadSnapshot(env);
    const v = validateShare(snap, code);
    if (v.error) return fail('分享链接无效或已过期', 403);
    if (v.share.type !== kind) return fail('分享链接无效或已过期', 403);
    if (v.share.name !== name) return fail('分享链接无效或已过期', 403);

    if (kind === 'file') {
        const f = snap.files.find((x) => x.name === name);
        if (!f) return fail('分享链接无效或已过期', 403);
        if (ctx?.waitUntil) {
            ctx.waitUntil(
                recordPull(env, { type: '分享文件', item: name, ip: clientIp(request) }).catch(() => {}),
            );
        }
        if (f.source === 'remote' && f.url) {
            return Response.redirect(f.url, 302);
        }
        return text(f.content || '', 200, 'text/plain;charset=UTF-8', {
            'Access-Control-Allow-Origin': '*',
        });
    }

    // 成品：内容已经是转换后的最终产物，**不能再走一次转换** —— 直接原样吐出去。
    // 这也是它和 sub/col 的本质差别：那两个是「原始订阅」，交给 SCE 现转；
    // 成品是「转换结果快照」，再转一遍只会把它毁掉。
    if (kind === 'converted') {
        const c = snap.converted.find((x) => x.name === name);
        if (!c) return fail('分享链接无效或已过期', 403);
        if (ctx?.waitUntil) {
            ctx.waitUntil(
                recordPull(env, { type: '分享成品', item: name, ip: clientIp(request) }).catch(() => {}),
            );
        }
        return text(c.content || '', 200, contentTypeForTarget(c.target), {
            'Access-Control-Allow-Origin': '*',
        });
    }

    // sub / col
    const q = new URLSearchParams(query);
    q.delete('code');
    if (kind === 'sub') q.set('sub', name);
    else q.set('collection', name);

    // 与 /download 同语义：分享码通道 = 编辑后的订阅（raw），target 一律忽略
    //（见 handleDownload 注释）。
    q.set('target', 'raw');

    const res = await handleSub(request, env, ctx, { query: q, method, tokenFromAuth: '' });
    if (res.ok && ctx?.waitUntil) {
        ctx.waitUntil(
            recordPull(env, {
                type: kind === 'sub' ? '分享订阅' : '分享组合',
                item: name,
                ip: clientIp(request),
            }).catch(() => {}),
        );
    }
    return res;
}

// ---------------------------------------------------------------- 链接生成

/**
 * 生成分发链接。给前端「复制订阅」用。
 *
 * 返回两条：
 *   link     —— 带派生分发密钥（?ft=），可安全发给别人 / 粘进客户端。
 *               **永远是编辑后的订阅（Sub-Store 模式）**：URI 来源 → base64
 *               URI 通用订阅，clash 来源 → 本地 clash YAML；target 参数
 *               已不再写入链接（/download 分发通道会忽略它）。
 *   adminLink —— 带管理令牌，只在本机排障时用，不要外发
 *
 * 两种寻址方式：
 *   · 具名（sub / col）—— 名字直接进路径；
 *   · adhoc（多来源临时选择）—— 选择本身没有名字，用 base64 spec 承载，密钥按 spec 短哈希派生。
 *     两者都走 /download/… + /feed/… 同一套派生密钥，因此不需要额外的存储或分享码。
 */
export async function buildLinks(request, env, snap, { kind, name, target = '', adhoc = null }) {
    const base = publicBase(request, snap.settings);
    await feedSaltOf(env, snap);

    // ---- adhoc：多来源临时选择 ----
    if (adhoc) {
        const spec = b64urlEncode(JSON.stringify(adhoc));
        const ft = await deriveFeedKey(env, snap.settings, 'adhoc', shortHash(spec));

        const dl = new URLSearchParams();
        dl.set('spec', spec);
        // target 不写入分发链接：/download 分发通道一律输出编辑后的订阅
        dl.set('ft', ft);

        const admin = new URLSearchParams(dl);
        admin.delete('ft');
        admin.set('token', String(env.SUBPILOT_TOKEN || ''));

        return {
            link: `${base}/download/adhoc?${dl.toString()}`,
            adminLink: `${base}/download/adhoc?${admin.toString()}`,
            feedUrl: `${base}/feed/adhoc?spec=${spec}&ft=${ft}`,
            feedKey: ft,
        };
    }

    const ft = await deriveFeedKey(env, snap.settings, kind, name);
    const path =
        kind === 'col'
            ? `/download/collection/${encodeURIComponent(name)}`
            : `/download/${encodeURIComponent(name)}`;

    const qs = new URLSearchParams();
    // target 不写入分发链接（参数保留在签名里只为调用方兼容）：分发通道
    // 一律输出编辑后的订阅，见本函数头注释与 handleDownload 注释
    qs.set('ft', ft);

    const admin = new URLSearchParams(qs);
    admin.delete('ft');
    admin.set('token', String(env.SUBPILOT_TOKEN || ''));

    const feedPath =
        kind === 'col'
            ? `/feed/col/${encodeURIComponent(name)}?ft=${ft}`
            : `/feed/sub/${encodeURIComponent(name)}?ft=${ft}`;

    return {
        link: `${base}${path}?${qs.toString()}`,
        adminLink: `${base}${path}?${admin.toString()}`,
        feedUrl: `${base}${feedPath}`,
        feedKey: ft,
    };
}

export function handleHealthz() {
    return ok({ status: 'ok', app: 'SubPilot' });
}
