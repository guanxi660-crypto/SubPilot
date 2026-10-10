// 订阅取源 → 解析 → JSON 算子处理 → 重新序列化。
//
// 关键分工：
//   · 有算子（或有本地内容）→ 本地取源处理，产出交给 /feed 端点，再把 feed 地址给 SCE
//   · 无算子且全是远程订阅 → 直接把原始 URL 交给 SCE（保留它的 Provider 模式，
//     这是 SubConverter-Extended 的设计初衷：后端不代取订阅，客户端自己更新）
//
// 换句话说：只有在需要改写节点时才让后端代取，其余情况不打断 SCE 的原生流程。

import { parseNodes, serializeNodes, summarize, renameNode } from './nodes.js';
import { applyOperators } from './operators.js';
import { safeFetch, ssrfOptions } from './netguard.js';

const FETCH_TIMEOUT = 15000;

/**
 * 来源引用的显式前缀。
 *
 * 历史：项目最初叫 SubPilot X，显式引用写作 `spx://名称`。改名 SubPilot 后
 * 统一成 `sp://名称`，但 KV 里已经存下的老配置仍带 `spx://` —— 两个都要认，
 * 否则老用户保存的转换配置会解析不出站内订阅（症状是「找不到订阅：xxx」，
 * 或者多选来源时 400）。
 *
 * ⚠️ 必须用**前缀自身的长度**去切。改名时 `spx://` → `sp://` 只换了字面量、
 * 没跟着把 `slice(6)` 改成 `slice(5)`，多切掉首字符 —— 这种 bug 就是写死偏移
 * 招来的。下面的 stripRefPrefix 让偏移永远跟着前缀走。
 */
const REF_PREFIXES = ['sp://', 'spx://'];

/**
 * 若 raw 是显式引用（`sp://名称` / `spx://名称`），返回其中的名称；否则返回 null。
 * pipeline.js 与 convert.js 共用，避免两边各写一套前缀规则。
 */
export function stripRefPrefix(raw) {
    const s = String(raw || '');
    const low = s.toLowerCase();
    for (const p of REF_PREFIXES) {
        if (low.startsWith(p)) return s.slice(p.length);
    }
    return null;
}

/**
 * 抓远程订阅正文。失败抛错，由调用方决定是整体失败还是跳过该源。
 *
 * 这是全站**唯一**拉取用户提供 URL 的出口（`/sub`、`/feed`、`/download`、
 * `/api/preview/*` 都经由它），所以 SSRF 守卫就挂在这里，不必在每个调用点重复
 * （审计 M2）。守卫做三件事：协议/主机名/字面私网 IP 检查、可选的域名解析复核、
 * 以及**自己逐跳跟随重定向**（`redirect: 'follow'` 看不到第二跳落到哪里）。
 */
export async function fetchSubText(url, ua = '', env = null) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
        const res = await safeFetch(
            url,
            {
                headers: {
                    'User-Agent': ua || 'clash-verge/v2.0 SubPilot/0.1',
                    Accept: '*/*',
                },
                signal: ctrl.signal,
            },
            // 订阅地址允许 http://（不少人把订阅放在明文 http 上），
            // 但内网 / 环回 / 元数据地址一律挡住。
            ssrfOptions(env, { allowHttp: true, label: '订阅地址' }),
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } catch (e) {
        // 被守卫拦下的错误已经是一条给用户看的完整说明，别再套一层「拉取订阅失败」
        if (e?.code === 'SSRF_BLOCKED') throw e;
        const msg = e.name === 'AbortError' ? '请求超时' : e.message || String(e);
        throw new Error(`拉取订阅失败（${msg}）`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 把各种来源引用统一成「一段正文」。
 * 支持三种引用：
 *   · 已存订阅名（在 snap.subs 里能查到）
 *   · 裸 URL
 *   · sp://<名称> 显式引用（避免订阅名恰好长得像域名时歧义）
 *     也认改名前的 spx://<名称>，见 stripRefPrefix 的说明。
 *
 * 注：只在本文件内使用（runPipeline），因此不对外导出。
 */
async function resolveSource(snap, ref, uaOverride = '', env = null) {
    const raw = String(ref || '').trim();
    if (!raw) return null;

    let name = '';
    const explicit = stripRefPrefix(raw);
    if (explicit !== null) name = explicit;
    else if (!/^https?:\/\//i.test(raw)) name = raw;

    if (name) {
        const sub = snap.subs.find((s) => s.name === name);
        if (sub) return sourceFromSub(sub, uaOverride);
        if (/^https?:\/\//i.test(raw)) {
            // 落下来当裸 URL 处理
        } else {
            throw new Error(`找不到订阅：${name}`);
        }
    }

    const text = await fetchSubText(raw, uaOverride, env);
    return { kind: 'url', name: raw, text, ua: uaOverride };
}

function sourceFromSub(sub, uaOverride) {
    if (sub.source === 'local') {
        return { kind: 'local', name: sub.name, text: sub.content || '', ua: '' };
    }
    const urls = String(sub.url || '')
        .split(/[\r\n]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    if (!urls.length) throw new Error(`订阅「${sub.name}」没有填写地址`);
    return { kind: 'remote', name: sub.name, urls, ua: uaOverride || sub.ua || '' };
}

/** 取一段来源的实际正文（远程的可能有多个 URL，逐个抓后拼接） */
async function materialize(src, env = null) {
    if (src.kind === 'local') return src.text;
    if (src.text) return src.text;
    const chunks = [];
    for (const u of src.urls) chunks.push(await fetchSubText(u, src.ua, env));
    return chunks.join('\n');
}

/**
 * 执行「取源 → 解析 → 算子 → 合并 → 序列化」。
 *
 * @param {object} opts
 * @param {Array}  opts.sources   [{ref, process}] 列表；ref 是订阅名或 URL
 * @param {Array}  opts.process   合并后再统一执行一遍的算子（组合层算子）
 * @returns {{nodes, format, text, log, summary}}
 */
export async function runPipeline(env, snap, { sources = [], process = [] } = {}) {
    const log = [];
    const collected = [];
    let format = '';

    for (const item of sources) {
        const src = await resolveSource(snap, item.ref, item.ua, env);
        if (!src) continue;
        const text = await materialize(src, env);
        const parsed = parseNodes(text);
        if (parsed.error) {
            log.push(`来源「${src.name}」：${parsed.error}`);
            continue;
        }
        if (!format) format = parsed.format;
        let nodes = parsed.nodes;
        const own = Array.isArray(item.process) ? item.process : [];
        if (own.length) {
            const r = applyOperators(nodes, own);
            nodes = r.nodes;
            for (const l of r.log) log.push(`[${src.name}] ${l}`);
        }
        log.push(`来源「${src.name}」：${nodes.length} 个节点`);
        collected.push(...nodes);
    }

    if (!format) format = 'uri';

    // 组合层算子作用在合并后的全量节点上
    let nodes = collected;
    if (Array.isArray(process) && process.length) {
        const r = applyOperators(nodes, process);
        nodes = r.nodes;
        for (const l of r.log) log.push(`[组合层] ${l}`);
    }

    // 重名兜底：不同来源合并后极易撞名，不处理的话客户端里会看到一堆同名节点
    nodes = dedupeSafe(nodes);

    return {
        nodes,
        format,
        text: serializeNodes(nodes, format),
        log,
        summary: summarize(nodes),
    };
}

/**
 * 合并后的重名兜底。
 * 只加序号，不删节点 —— 删掉的话用户会以为是订阅本身缺节点。
 */
function dedupeSafe(nodes) {
    const seen = new Map();
    for (const n of nodes) {
        const c = seen.get(n.name) || 0;
        seen.set(n.name, c + 1);
        if (c > 0) renameNode(n, `${n.name} #${c + 1}`);
    }
    return nodes;
}

/** 只解析 + 处理，不取远程 —— 用于「脚本处理」页的实时预览 */
export function previewText(text, process = []) {
    const parsed = parseNodes(text);
    if (parsed.error) return { format: parsed.format, nodes: [], log: [parsed.error], summary: [] };
    const r = applyOperators(parsed.nodes, process);
    return {
        format: parsed.format,
        nodes: r.nodes,
        log: r.log,
        summary: summarize(r.nodes),
    };
}
