
import { parseNodes, serializeNodes, summarize, renameNode } from './nodes.js';
import { applyOperators } from './operators.js';
import { safeFetch, ssrfOptions } from './netguard.js';

const FETCH_TIMEOUT = 15000;


const REF_PREFIXES = ['sp://', 'spx://'];


export function stripRefPrefix(raw) {
    const s = String(raw || '');
    const low = s.toLowerCase();
    for (const p of REF_PREFIXES) {
        if (low.startsWith(p)) return s.slice(p.length);
    }
    return null;
}


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
            
            
            ssrfOptions(env, { allowHttp: true, label: '订阅地址' }),
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } catch (e) {
        
        if (e?.code === 'SSRF_BLOCKED') throw e;
        const msg = e.name === 'AbortError' ? '请求超时' : e.message || String(e);
        throw new Error(`拉取订阅失败（${msg}）`);
    } finally {
        clearTimeout(timer);
    }
}


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


async function materialize(src, env = null) {
    if (src.kind === 'local') return src.text;
    if (src.text) return src.text;
    const chunks = [];
    for (const u of src.urls) chunks.push(await fetchSubText(u, src.ua, env));
    return chunks.join('\n');
}


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

    
    let nodes = collected;
    if (Array.isArray(process) && process.length) {
        const r = applyOperators(nodes, process);
        nodes = r.nodes;
        for (const l of r.log) log.push(`[组合层] ${l}`);
    }

    
    nodes = dedupeSafe(nodes);

    return {
        nodes,
        format,
        text: serializeNodes(nodes, format),
        log,
        summary: summarize(nodes),
    };
}


function dedupeSafe(nodes) {
    const seen = new Map();
    for (const n of nodes) {
        const c = seen.get(n.name) || 0;
        seen.set(n.name, c + 1);
        if (c > 0) renameNode(n, `${n.name} #${c + 1}`);
    }
    return nodes;
}


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
