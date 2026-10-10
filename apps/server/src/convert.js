
import { safeEqual, b64decode, b64encode, b64urlEncode, ok, fail, text, toStringArray, isPlainObject, ApiError } from './util.js';
import { loadSnapshot, recordPull, mutate } from './storage.js';
import { resolveBackend, callSce, describeSceError, buildSceUrl } from './sce.js';
import { runPipeline, stripRefPrefix } from './pipeline.js';
import { serializeNodes } from './nodes.js';
import { deriveFeedKey, ensureFeedSalt, checkFeedKey } from './feedkey.js';
import { checkUrl, ssrfOptions } from './netguard.js';


export function publicBase(request, settings) {
    const configured = String(settings?.publicBaseUrl || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
}


export function clientIp(request) {
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


function needsLocalProcessing({ sources, process, sub, collection }) {
    if (Array.isArray(process) && process.length) return true;
    if (sources.some((s) => Array.isArray(s.process) && s.process.length)) return true;
    if (sources.some((s) => s.kind === 'local')) return true;
    if (sub && sub.source === 'local') return true;
    return false;
}


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


const SCE_PREFIX_TARGETS = new Set(['clash']);


function sanitizePrefixValue(v) {
    return String(v || '').replace(/[,|\r\n]/g, ' ').trim();
}


function sourceLabel(snap, ref) {
    const stored = snap.subs.find((x) => x.name === ref);
    if (stored) return stored.displayName || stored.name || '';
    
    const col = (snap.collections || []).find((x) => x.name === ref);
    if (col) return col.displayName || col.name || '';
    try {
        return new URL(ref).hostname;
    } catch {
        return '';
    }
}


function decorateSourceUrl(url, label, target) {
    const base = String(target || '').split('&')[0].toLowerCase();
    if (!SCE_PREFIX_TARGETS.has(base)) return url;
    const tag = sanitizePrefixValue(label);
    if (!tag) return url;
    return `tag:${tag},provider:${tag},${url}`;
}


async function feedSaltOf(env, snap) {
    if (snap.settings.feedSalt) return snap.settings.feedSalt;
    const { result } = await ensureFeedSalt(env, mutate);
    snap.settings.feedSalt = result;
    return result;
}


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




async function prepareConversion(request, env, snap, params) {
    const base = resolveBackend(env, snap.settings);

    
    let sub = null;
    let collection = null;
    const sources = [];
    let process = [];

    if (params.sub) {
        sub = snap.subs.find((s) => s.name === params.sub);
        if (!sub) throw new ApiError(`订阅不存在：${params.sub}`, 404);
        sources.push({ ref: sub.name, process: sub.process || [] });
    } else if (params.collection) {
        collection = snap.collections.find((c) => c.name === params.collection);
        if (!collection) throw new ApiError(`组合不存在：${params.collection}`, 404);
        for (const n of collection.subscriptions || []) {
            const s = snap.subs.find((x) => x.name === n);
            if (s)
                sources.push({
                    ref: s.name,
                    process: s.process || [],
                    
                    
                    
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
            throw new ApiError('process 参数不是合法的 base64 JSON 数组', 400);
        }
    }

    if (!sources.length) {
        throw new ApiError('缺少来源：请提供 url、sub 或 collection 参数', 400);
    }

    
    
    
    
    if (params.target === 'raw') return { raw: true, base, sources, process };

    const forceDirect = params.direct === '1' || params.direct === 'true';
    const local = !forceDirect && needsLocalProcessing({ sources, process, sub, collection });

    
    const sceParams = { ...params };
    delete sceParams.sub;
    delete sceParams.collection;
    delete sceParams.process;
    delete sceParams.direct;
    delete sceParams.token;
    delete sceParams.ft;

    
    if (!sceParams.target) sceParams.target = snap.settings.defaultTarget || 'clash';
    if (!sceParams.config && snap.settings.defaultConfig) sceParams.config = snap.settings.defaultConfig;

    if (local) {
        if (!sub && !collection && sources.length > 1 && !(Array.isArray(process) && process.length)) {
            
            
            
            
            const parts = [];
            for (const s of sources) {
                const feedUrl = await buildFeedUrl(env, snap, {
                    base: publicBase(request, snap.settings),
                    adhoc: adhocSpec([s], []),
                });
                if (feedUrl.length > 4000) {
                    throw new ApiError(
                        '算子链过长，生成的 feed 地址超过 4000 字符。请精简算子，或把它保存为订阅后再分发。',
                        400,
                    );
                }
                parts.push(decorateSourceUrl(feedUrl, sourceLabel(snap, s.ref), sceParams.target));
            }
            sceParams.url = parts.join('|');
        } else {
            
            const adhoc = sub || collection ? null : adhocSpec(sources, process);
            const feedUrl = await buildFeedUrl(env, snap, {
                base: publicBase(request, snap.settings),
                sub: sub?.name,
                collection: collection?.name,
                adhoc,
            });
            if (feedUrl.length > 4000) {
                throw new ApiError(
                    '算子链过长，生成的 feed 地址超过 4000 字符。请精简算子，或把它保存为订阅后再分发。',
                    400,
                );
            }
            
            
            const label = sub
                ? sourceLabel(snap, sub.name)
                : collection
                  ? sourceLabel(snap, collection.name)
                  : sourceLabel(snap, sources[0]?.ref);
            sceParams.url = decorateSourceUrl(feedUrl, label, sceParams.target);
        }
    } else {
        
        
        
        
        
        
        
        const urls = [];
        for (const s of sources) {
            const stored = snap.subs.find((x) => x.name === s.ref);
            if (stored) {
                if (stored.source === 'local') {
                    throw new ApiError(
                        `订阅「${stored.name}」是本地内容，必须走本地处理（请去掉 direct=1）`,
                        400,
                    );
                }
                for (const u of toStringArray(stored.url)) {
                    const bad = await checkUrl(
                        u,
                        ssrfOptions(env, { allowHttp: true, label: `订阅「${stored.name}」的地址` }),
                    );
                    if (bad) throw new ApiError(bad, 400);
                    urls.push(decorateSourceUrl(u, sourceLabel(snap, s.ref), sceParams.target));
                }
            } else {
                const bad = await checkUrl(
                    s.ref,
                    ssrfOptions(env, { allowHttp: true, label: '来源地址' }),
                );
                if (bad) throw new ApiError(bad, 400);
                urls.push(decorateSourceUrl(s.ref, sourceLabel(snap, s.ref), sceParams.target));
            }
        }
        sceParams.url = urls.join('|');
    }

    return { raw: false, base, sceParams, local };
}


async function rawChannel(env, snap, sources, process) {
    let result;
    try {
        result = await runPipeline(env, snap, { sources, process });
    } catch (e) {
        throw new ApiError(`节点处理失败：${e.message || e}`, 500);
    }

    if (!result.nodes.length) throw new ApiError('来源没有可分发的节点', 404);

    
    
    
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


export async function handleSub(request, env, ctx, { query, method, tokenFromAuth }) {
    const snap = await loadSnapshot(env);
    const prep = await prepareConversion(request, env, snap, extractParams(query));
    if (prep.raw) return rawChannel(env, snap, prep.sources, prep.process);

    const { base, sceParams, local } = prep;

    
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


export async function handleConvertLink(request, env, ctx, { query }) {
    const snap = await loadSnapshot(env);
    const prep = await prepareConversion(request, env, snap, extractParams(query));
    if (prep.raw) {
        throw new ApiError('target=raw 由本站本地直出，不经过转换后端，没有后端链接', 400);
    }
    return ok({
        backend: prep.base,
        local: prep.local,
        url: buildSceUrl(prep.base, prep.sceParams),
    });
}


export function convertedBackendLink({ env, snap, item, base, code }) {
    const name = String(item?.name || '').trim();
    
    const saved = String(item?.backendUrl || '').trim();
    if (saved) return saved;
    
    const origin = String(base || '').replace(/\/+$/, '');
    if (!name || !origin) return '';
    const c =
        code ||
        (snap?.shares || []).find((s) => s.type === 'converted' && s.name === name)?.code ||
        '';
    if (!c) return '';
    
    const target =
        item?.target && item.target !== 'raw'
            ? item.target
            : snap?.settings?.defaultTarget || 'clash';
    const params = {
        target,
        url: `${origin}/share/converted/${encodeURIComponent(name)}?code=${c}`,
    };
    if (item?.template) params.config = String(item.template);
    return buildSceUrl(resolveBackend(env, snap?.settings), params);
}


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




export async function handleFeed(request, env, ctx, { path, query, tokenFromAuth }) {
    const seg = path.replace(/^\/feed\/?/, '').split('/').filter(Boolean);
    const kind = seg[0];
    const name = seg[1] ? decodeURIComponent(seg[1]) : '';
    const specRaw = query.get('spec') || '';
    
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



export async function handleDownload(request, env, ctx, { path, query, method, tokenFromAuth }) {
    const seg = path.replace(/^\/download\/?/, '').split('/').filter(Boolean);
    const isCollection = seg[0] === 'collection';
    
    
    
    
    
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
        
        
        q.set('url', refs.join('|'));
        if (Array.isArray(spec.process) && spec.process.length) {
            q.set('process', b64encode(JSON.stringify(spec.process)));
        }
        
        pullName = `多来源 · ${refs.length} 项`;
    } else if (isCollection) {
        q.set('collection', name);
    } else {
        q.set('sub', name);
    }

    
    
    
    
    
    
    
    q.set('target', 'raw');

    const res = await handleSub(request, env, ctx, { query: q, method, tokenFromAuth });

    
    
    if (res.ok && ctx?.waitUntil && !isTgCrawler(request)) {
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


function isTgCrawler(request) {
    const ua = request?.headers?.get?.('user-agent') || '';
    return /\bTelegramBot\b/i.test(ua);
}




const YAML_TARGETS = new Set(['clash']);
const JSON_TARGETS = new Set(['singbox']);

function contentTypeForTarget(target) {
    const t = String(target || '').toLowerCase();
    if (YAML_TARGETS.has(t)) return 'text/yaml;charset=UTF-8';
    if (JSON_TARGETS.has(t)) return 'application/json;charset=UTF-8';
    
    
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

    
    const snap = await loadSnapshot(env);
    const v = validateShare(snap, code);
    if (v.error) return fail('分享链接无效或已过期', 403);
    if (v.share.type !== kind) return fail('分享链接无效或已过期', 403);
    if (v.share.name !== name) return fail('分享链接无效或已过期', 403);

    if (kind === 'file') {
        const f = snap.files.find((x) => x.name === name);
        if (!f) return fail('分享链接无效或已过期', 403);
        if (ctx?.waitUntil && !isTgCrawler(request)) {
            ctx.waitUntil(
                recordPull(env, { type: '分享文件', item: name, ip: clientIp(request) }).catch(() => {}),
            );
        }
        if (f.source === 'remote' && f.url) {
            
            
            if (!/^https?:\/\//i.test(f.url)) {
                return fail('远程文件地址不是 http(s)，拒绝跳转', 502);
            }
            return Response.redirect(f.url, 302);
        }
        return text(f.content || '', 200, 'text/plain;charset=UTF-8', {
            'Access-Control-Allow-Origin': '*',
        });
    }

    
    
    
    if (kind === 'converted') {
        const c = snap.converted.find((x) => x.name === name);
        if (!c) return fail('分享链接无效或已过期', 403);
        if (ctx?.waitUntil && !isTgCrawler(request)) {
            ctx.waitUntil(
                recordPull(env, { type: '分享成品', item: name, ip: clientIp(request) }).catch(() => {}),
            );
        }
        return text(c.content || '', 200, contentTypeForTarget(c.target), {
            'Access-Control-Allow-Origin': '*',
        });
    }

    
    const q = new URLSearchParams(query);
    q.delete('code');
    if (kind === 'sub') q.set('sub', name);
    else q.set('collection', name);

    
    
    q.set('target', 'raw');

    const res = await handleSub(request, env, ctx, { query: q, method, tokenFromAuth: '' });
    if (res.ok && ctx?.waitUntil && !isTgCrawler(request)) {
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




export async function buildLinks(request, env, snap, { kind, name, target = '', adhoc = null }) {
    const base = publicBase(request, snap.settings);
    await feedSaltOf(env, snap);

    
    if (adhoc) {
        const spec = b64urlEncode(JSON.stringify(adhoc));
        const ft = await deriveFeedKey(env, snap.settings, 'adhoc', shortHash(spec));

        const dl = new URLSearchParams();
        dl.set('spec', spec);
        
        dl.set('ft', ft);

        return {
            link: `${base}/download/adhoc?${dl.toString()}`,
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
    
    
    qs.set('ft', ft);

    const feedPath =
        kind === 'col'
            ? `/feed/col/${encodeURIComponent(name)}?ft=${ft}`
            : `/feed/sub/${encodeURIComponent(name)}?ft=${ft}`;

    return {
        link: `${base}${path}?${qs.toString()}`,
        feedUrl: `${base}${feedPath}`,
        feedKey: ft,
    };
}

export function handleHealthz() {
    return ok({ status: 'ok', app: 'SubPilot' });
}
