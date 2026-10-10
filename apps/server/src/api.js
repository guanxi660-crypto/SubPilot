import {
    ok,
    fail,
    isPlainObject,
    validateName,
    toStringArray,
    pick,
    nowIso,
    randId,
    maskSecret,
    ApiError,
} from './util.js';
import { loadSnapshot, mutate, loadStats, clearStats, MAX_STATS_ITEMS } from './storage.js';
import { resolveBackend, probeBackend, SCE_TARGETS } from './sce.js';
import { runPipeline, previewText, fetchSubText } from './pipeline.js';
import { buildLinks, resolveSourceRefs, adhocSpec, publicBase, convertedBackendLink } from './convert.js';
import { OPERATOR_TYPES, PROCESS_PRESETS } from './operators.js';
import { handleTemplates, sanitizeProcess } from './templates.js';

import serverPkg from '../package.json' with { type: 'json' };

const SUB_FIELDS = ['name', 'displayName', 'source', 'url', 'content', 'ua', 'process', 'remark'];
const FILE_FIELDS = ['name', 'displayName', 'source', 'url', 'content'];
const COL_FIELDS = ['name', 'displayName', 'subscriptions', 'process', 'remark'];

const ALLOWED_FILE_EXT = [
    'js', 'mjs', 'cjs', 'json', 'txt', 'md', 'ini', 'conf', 'cfg', 'yaml', 'yml',
    'toml', 'list', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'sh', 'bat',
    'ps1', 'py', 'sql', 'properties', 'rules',
];
const MAX_FILE_BYTES = 512 * 1024;

const MAX_SUB_BYTES = 8 * 1024 * 1024;

function fileBytes(content) {
    return new TextEncoder().encode(String(content ?? '')).length;
}

function fmtBytes(n) {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MiB`;
    if (n >= 1024) return `${Math.round(n / 1024)}KiB`;
    return `${n}B`;
}

function subErrorStatus(body) {
    return fileBytes(body?.content) > MAX_SUB_BYTES ? 413 : 400;
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function applyOrder(list, names) {
    const index = new Map(names.map((n, i) => [n, i]));
    return [...list].sort((a, b) => {
        const ia = index.has(a.name) ? index.get(a.name) : Number.MAX_SAFE_INTEGER;
        const ib = index.has(b.name) ? index.get(b.name) : Number.MAX_SAFE_INTEGER;
        return ia - ib;
    });
}

function ensureConvertedShare(s, name) {
    const mine = (s.shares || []).filter((sh) => sh.type === 'converted' && sh.name === name);
    if (!mine.length) {
        const code = randId(25);
        s.shares.push({ code, type: 'converted', name, createdAt: nowIso(), expiresAt: null, uses: 0 });
        return code;
    }
    
    const keep = mine.reduce((a, b) => ((a.createdAt || '') <= (b.createdAt || '') ? a : b));
    keep.expiresAt = null;
    if (mine.length > 1) {
        const drop = new Set(mine.filter((x) => x !== keep).map((x) => x.code));
        s.shares = s.shares.filter((sh) => !drop.has(sh.code));
    }
    return keep.code;
}

function withShareCode(snap, { content, ...rest }, { request, env } = {}) {
    const hit = (snap.shares || []).find((sh) => sh.type === 'converted' && sh.name === rest.name);
    const shareCode = hit?.code || '';
    return {
        ...rest,
        size: fileBytes(content),
        shareCode,
        link: convertedBackendLink({
            env,
            snap,
            item: rest,
            base: publicBase(request, snap.settings),
            code: shareCode,
        }),
    };
}

export function publicSettings(settings) {
    const s = JSON.parse(JSON.stringify(settings || {}));
    const ai = s.ai || {};
    s.ai = {
        baseUrl: ai.baseUrl || '',
        model: ai.model || '',
        hasApiKey: !!ai.apiKey,
        apiKeyMask: maskSecret(ai.apiKey),
    };
    const sync = s.sync || {};
    s.sync = {
        provider: sync.provider || 'none',
        gist: {
            gistId: sync.gist?.gistId || '',
            hasToken: !!sync.gist?.token,
            tokenMask: maskSecret(sync.gist?.token),
        },
        webdav: {
            url: sync.webdav?.url || '',
            user: sync.webdav?.user || '',
            dir: sync.webdav?.dir || '',
            hasPass: !!sync.webdav?.pass,
            passMask: maskSecret(sync.webdav?.pass),
        },
    };
    
    
    const tg = s.telegram || {};
    s.telegram = {
        tokenSet: !!tg.token,
        tokenMask: maskSecret(tg.token),
        chatIds: tg.chatIds || '',
        targets: Array.isArray(tg.targets) ? tg.targets : [],
        linkType: tg.linkType || '',
        autoPush: !!tg.autoPush,
        lastPush: tg.lastPush || null,
    };
    return s;
}

function mergeSecret(incoming, current) {
    if (typeof incoming !== 'string') return current;
    const t = incoming.trim();
    if (!t || t.includes('****')) return current;
    return t;
}

export async function handleApi(request, env, ctx, { method, path, query }) {
    const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);

    

    if (method === 'GET' && seg[0] === 'utils' && seg[1] === 'env') {
        const snap = await loadSnapshot(env);
        const base = resolveBackend(env, snap.settings);
        const probe = await probeBackend(base);
        return ok({
            backend: 'SubPilot',
            version: serverPkg.version,
            subBackend: base,
            sceVersion: probe.version,
            online: probe.online,
            error: probe.error,
            feature: [
                'sub-store',
                'json-process',
                'sce-delegate',
                'share',
                'ai',
                'sync',
                'telegram',
            ],
        });
    }

    if (method === 'GET' && seg[0] === 'operators') {
        
        
        const snap = await loadSnapshot(env);
        return ok({
            types: OPERATOR_TYPES,
            presets: PROCESS_PRESETS,
            templates: snap.templates,
            targets: SCE_TARGETS,
        });
    }

    
    if (seg[0] === 'templates' || seg[0] === 'template') {
        return handleTemplates(env, { method, seg, body });
    }

    

    if (seg[0] === 'link' && method === 'GET') {
        const kind = query.get('kind') === 'col' ? 'col' : 'sub';
        const name = String(query.get('name') || '');
        const target = String(query.get('target') || '');
        const snap = await loadSnapshot(env);
        const pool = kind === 'col' ? snap.collections : snap.subs;
        if (!pool.some((x) => x.name === name)) return fail(`资源不存在：${name}`, 404);
        return ok(await buildLinks(request, env, snap, { kind, name, target }));
    }

    
    
    
    if (seg[0] === 'link' && method === 'POST') {
        const snap = await loadSnapshot(env);
        const sources = resolveSourceRefs(snap, body.sources);
        if (!sources.length) return fail('请至少提供一个来源', 400);
        return ok(
            await buildLinks(request, env, snap, {
                adhoc: adhocSpec(sources, body.process),
                target: String(body.target || ''),
            }),
        );
    }

    
    if (seg[0] === 'feedkey' && seg[1] === 'rotate' && method === 'POST') {
        const { snap } = await mutate(env, (s) => {
            s.settings.feedSalt = randId(24);
            s.settings.feedSaltCreatedAt = nowIso();
        });
        return ok({ rotatedAt: snap.settings.feedSaltCreatedAt });
    }

    

    if (seg[0] === 'subs' && method === 'GET') {
        const snap = await loadSnapshot(env);
        return ok(snap.subs);
    }

    if (seg[0] === 'subs' && method === 'POST') {
        const err = validateSub(body);
        if (err) return fail(err, subErrorStatus(body));
        const { snap, result } = await mutate(env, (s) => {
            if (s.subs.some((x) => x.name === body.name)) return { error: '名称已被占用' };
            const item = normalizeSub(body);
            s.subs.unshift(item);
            return { item };
        });
        if (result.error) return fail(result.error, 409);
        return ok(snap.subs, 201);
    }

    if (seg[0] === 'sub' && seg.length === 2) {
        const name = decodeURIComponent(seg[1]);
        if (method === 'GET') {
            const snap = await loadSnapshot(env);
            const item = snap.subs.find((s) => s.name === name);
            return item ? ok(item) : fail(`订阅不存在：${name}`, 404);
        }
        if (method === 'PATCH') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.subs.findIndex((x) => x.name === name);
                if (idx < 0) return { error: `订阅不存在：${name}`, status: 404 };
                const mergedInput = { ...s.subs[idx], ...pick(body, SUB_FIELDS) };
                
                
                
                const verr = validateSub({ ...mergedInput, name });
                if (verr) return { error: verr, status: subErrorStatus(mergedInput) };
                const merged = normalizeSub(mergedInput, s.subs[idx]);
                merged.name = name; 
                merged.createdAt = s.subs[idx].createdAt;
                merged.updatedAt = nowIso();
                s.subs[idx] = merged;
                return { item: merged };
            });
            if (result.error) return fail(result.error, result.status || 400);
            return ok(snap.subs);
        }
        if (method === 'DELETE') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.subs.findIndex((x) => x.name === name);
                if (idx < 0) return { error: `订阅不存在：${name}`, status: 404 };
                s.subs.splice(idx, 1);
                
                let touched = 0;
                for (const c of s.collections) {
                    const before = c.subscriptions.length;
                    c.subscriptions = c.subscriptions.filter((n) => n !== name);
                    if (c.subscriptions.length !== before) touched += 1;
                }
                
                s.shares = s.shares.filter((sh) => !(sh.type === 'sub' && sh.name === name));
                return { touched };
            });
            if (result.error) return fail(result.error, result.status || 404);
            return ok(snap.subs);
        }
    }

    if (seg[0] === 'sub' && seg[2] === 'rename' && method === 'POST') {
        const oldName = decodeURIComponent(seg[1]);
        const newName = String(body.name ?? '').trim();
        if (!newName) return fail('新名称不能为空', 400);
        const nameErr = validateName(newName);
        if (nameErr) return fail(nameErr, 400);
        if (newName === oldName) return fail('新名称与原名称相同', 400);

        const { snap, result } = await mutate(env, (s) => {
            const item = s.subs.find((x) => x.name === oldName);
            if (!item) return { error: `订阅不存在：${oldName}`, status: 404 };
            if (s.subs.some((x) => x.name === newName)) {
                return { error: `名称已被占用：${newName}`, status: 409 };
            }
            item.name = newName;
            item.updatedAt = nowIso();
            
            let touched = 0;
            for (const c of s.collections) {
                const i = c.subscriptions.indexOf(oldName);
                if (i >= 0) {
                    c.subscriptions[i] = newName;
                    touched += 1;
                }
            }
            
            for (const sh of s.shares) {
                if (sh.type === 'sub' && sh.name === oldName) sh.name = newName;
            }
            return { touched };
        });
        if (result.error) return fail(result.error, result.status || 400);
        return ok(snap.subs);
    }

    if (seg[0] === 'sort' && seg[1] === 'subs' && method === 'POST') {
        const { snap } = await mutate(env, (s) => {
            s.subs = applyOrder(s.subs, toStringArray(body));
        });
        return ok(snap.subs);
    }

    

    if (seg[0] === 'collections' && method === 'GET') {
        const snap = await loadSnapshot(env);
        return ok(snap.collections);
    }

    if (seg[0] === 'collections' && method === 'POST') {
        const err = validateCol(body);
        if (err) return fail(err, 400);
        const { snap, result } = await mutate(env, (s) => {
            if (s.collections.some((x) => x.name === body.name)) return { error: '名称已被占用' };
            s.collections.unshift(normalizeCol(body));
            return {};
        });
        if (result.error) return fail(result.error, 409);
        return ok(snap.collections, 201);
    }

    if (seg[0] === 'collection' && seg.length === 2) {
        const name = decodeURIComponent(seg[1]);
        if (method === 'PATCH') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.collections.findIndex((x) => x.name === name);
                if (idx < 0) return { error: `组合不存在：${name}`, status: 404 };
                const merged = normalizeCol({ ...s.collections[idx], ...pick(body, COL_FIELDS) }, s.collections[idx]);
                merged.name = name;
                merged.createdAt = s.collections[idx].createdAt;
                merged.updatedAt = nowIso();
                s.collections[idx] = merged;
                return {};
            });
            if (result.error) return fail(result.error, result.status || 400);
            return ok(snap.collections);
        }
        if (method === 'DELETE') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.collections.findIndex((x) => x.name === name);
                if (idx < 0) return { error: `组合不存在：${name}`, status: 404 };
                s.collections.splice(idx, 1);
                s.shares = s.shares.filter((sh) => !(sh.type === 'col' && sh.name === name));
                return {};
            });
            if (result.error) return fail(result.error, result.status || 404);
            return ok(snap.collections);
        }
    }

    if (seg[0] === 'sort' && seg[1] === 'collections' && method === 'POST') {
        const { snap } = await mutate(env, (s) => {
            s.collections = applyOrder(s.collections, toStringArray(body));
        });
        return ok(snap.collections);
    }

    

    if (seg[0] === 'files' && method === 'GET') {
        const snap = await loadSnapshot(env);
        
        return ok(snap.files.map(({ content, ...rest }) => ({ ...rest, size: fileBytes(content) })));
    }

    
    
    if (seg[0] === 'file' && seg[1] && method === 'GET') {
        const snap = await loadSnapshot(env);
        const name = decodeURIComponent(seg[1]);
        const item = snap.files.find((f) => f.name === name);
        return item ? ok(item) : fail(`文件不存在：${name}`, 404);
    }

    if (seg[0] === 'files' && method === 'POST') {
        const err = validateFile(body);
        if (err) return fail(err, 400);
        const { snap, result } = await mutate(env, (s) => {
            if (s.files.some((f) => f.name === body.name)) return { error: '同名文件已存在', status: 409 };
            s.files.unshift(normalizeFile(body));
            return {};
        });
        if (result.error) return fail(result.error, result.status || 400);
        return ok(snap.files.map(({ content, ...rest }) => ({ ...rest, size: fileBytes(content) })), 201);
    }

    if (seg[0] === 'file' && seg.length === 2) {
        const name = decodeURIComponent(seg[1]);
        if (method === 'PATCH') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.files.findIndex((f) => f.name === name);
                if (idx < 0) return { error: `文件不存在：${name}`, status: 404 };
                const incoming = pick(body, FILE_FIELDS);
                const newName = String(incoming.name ?? name).trim();
                if (newName !== name && s.files.some((f) => f.name === newName)) {
                    return { error: `名称已被占用：${newName}`, status: 409 };
                }
                const merged = normalizeFile(
                    { ...s.files[idx], ...incoming, name: newName },
                    s.files[idx],
                );
                
                
                
                
                
                const verr = validateFile(merged);
                if (verr) return { error: verr, status: 400 };
                merged.createdAt = s.files[idx].createdAt;
                merged.updatedAt = nowIso();
                s.files[idx] = merged;
                if (newName !== name) {
                    for (const sh of s.shares) if (sh.type === 'file' && sh.name === name) sh.name = newName;
                }
                return { newName };
            });
            if (result.error) return fail(result.error, result.status || 400);
            return ok(snap.files.map(({ content, ...rest }) => ({ ...rest, size: fileBytes(content) })));
        }
        if (method === 'DELETE') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.files.findIndex((f) => f.name === name);
                if (idx < 0) return { error: `文件不存在：${name}`, status: 404 };
                s.files.splice(idx, 1);
                s.shares = s.shares.filter((sh) => !(sh.type === 'file' && sh.name === name));
                return {};
            });
            if (result.error) return fail(result.error, result.status || 404);
            return ok(snap.files.map(({ content, ...rest }) => ({ ...rest, size: fileBytes(content) })));
        }
    }

    if (seg[0] === 'sort' && seg[1] === 'files' && method === 'POST') {
        const { snap } = await mutate(env, (s) => {
            s.files = applyOrder(s.files, toStringArray(body));
        });
        return ok(snap.files.map(({ content, ...rest }) => ({ ...rest, size: fileBytes(content) })));
    }

    

    if (seg[0] === 'preview' && seg[1] === 'sub' && method === 'POST') {
        
        
        try {
            const sub = normalizeSub(body);
            let text = '';
            if (sub.source === 'local') text = sub.content || '';
            else {
                const urls = toStringArray(sub.url);
                if (!urls.length) return fail('请先填写订阅地址', 400);
                const chunks = [];
                for (const u of urls) chunks.push(await fetchSubText(u, sub.ua, env));
                text = chunks.join('\n');
            }
            const r = previewText(text, sub.process);
            return ok({ format: r.format, processed: r.summary, log: r.log, total: r.summary.length });
        } catch (e) {
            return fail(e.message, e.status || 400);
        }
    }

    if (seg[0] === 'preview' && seg[1] === 'process' && method === 'POST') {
        
        const process = Array.isArray(body.process) ? body.process : [];
        try {
            let text = String(body.content || '');
            if (!text && body.url) text = await fetchSubText(String(body.url), String(body.ua || ''), env);
            if (!text) return fail('请提供订阅内容或地址', 400);
            const r = previewText(text, process);
            return ok({ format: r.format, processed: r.summary, log: r.log, total: r.summary.length });
        } catch (e) {
            return fail(e.message, e.status || 400);
        }
    }

    if (seg[0] === 'preview' && seg[1] === 'collection' && method === 'POST') {
        const snap = await loadSnapshot(env);
        const names = toStringArray(body.subscriptions);
        if (!names.length) return fail('请至少选择一个订阅', 400);
        try {
            const sources = names.map((n) => {
                const sub = snap.subs.find((s) => s.name === n);
                return { ref: n, process: sub?.process || [] };
            });
            const r = await runPipeline(env, snap, { sources, process: body.process || [] });
            return ok({ format: r.format, processed: r.summary, log: r.log, total: r.summary.length });
        } catch (e) {
            return fail(e.message, e.status || 400);
        }
    }

    

    if (seg[0] === 'converted') {
        if (method === 'GET' && seg.length === 1) {
            const snap = await loadSnapshot(env);
            
            
            const missing = snap.converted.some(
                (c) => !(snap.shares || []).some((sh) => sh.type === 'converted' && sh.name === c.name),
            );
            if (missing) {
                const { snap: s2 } = await mutate(env, (s) => {
                    for (const c of s.converted) ensureConvertedShare(s, c.name);
                });
                return ok(s2.converted.map((c) => withShareCode(s2, c, { request, env })));
            }
            return ok(snap.converted.map((c) => withShareCode(snap, c, { request, env })));
        }
        if (method === 'POST') {
            const name = String(body.name || '').trim();
            const nameErr = validateName(name, { maxLen: 64 });
            if (nameErr) return fail(`成品${nameErr}`, 400);
            if (typeof body.content !== 'string' || !body.content) return fail('成品内容为空', 400);
            const bytes = new TextEncoder().encode(body.content).length;
            if (bytes > 16 * 1024 * 1024) return fail('成品内容超过 16MiB 上限', 413);
            
            
            
            const backendUrl = String(body.backendUrl || '').trim();
            if (backendUrl) {
                if (!/^https?:\/\//i.test(backendUrl)) return fail('成品链接必须是 http(s) 地址', 400);
                if (backendUrl.length > 4096) return fail('成品链接超过 4096 字符上限', 400);
            }
            const { snap } = await mutate(env, (s) => {
                const idx = s.converted.findIndex((c) => c.name === name);
                const item = {
                    name,
                    target: String(body.target || ''),
                    template: String(body.template || ''),
                    backendUrl,
                    content: body.content,
                    createdAt: idx >= 0 ? s.converted[idx].createdAt : nowIso(),
                    updatedAt: nowIso(),
                };
                if (idx >= 0) s.converted[idx] = item;
                else s.converted.unshift(item);
                
                ensureConvertedShare(s, name);
            });
            return ok(snap.converted.map((c) => withShareCode(snap, c, { request, env })), 201);
        }
        if (seg.length === 2) {
            const name = decodeURIComponent(seg[1]);
            const snap = await loadSnapshot(env);
            const item = snap.converted.find((c) => c.name === name);
            if (method === 'GET') return item ? ok(item) : fail('卡片不存在', 404);
            if (method === 'DELETE') {
                const { snap: s2, result } = await mutate(env, (s) => {
                    const idx = s.converted.findIndex((c) => c.name === name);
                    if (idx < 0) return { error: '卡片不存在', status: 404 };
                    s.converted.splice(idx, 1);
                    
                    s.shares = s.shares.filter((sh) => !(sh.type === 'converted' && sh.name === name));
                    return {};
                });
                if (result.error) return fail(result.error, result.status || 404);
                return ok(s2.converted.map((c) => withShareCode(s2, c, { request, env })));
            }
        }
    }

    

    if (seg[0] === 'shares') {
        if (method === 'GET') {
            const snap = await loadSnapshot(env);
            return ok([...snap.shares].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
        }
        if (method === 'POST') {
            const type = String(body.type || '');
            
            
            if (!['sub', 'col', 'file', 'converted'].includes(type)) {
                return fail('分享类型必须是 sub / col / file / converted', 400);
            }
            const name = String(body.name || '').trim();
            const snap0 = await loadSnapshot(env);
            const pool =
                type === 'sub'
                    ? snap0.subs
                    : type === 'col'
                      ? snap0.collections
                      : type === 'file'
                        ? snap0.files
                        : snap0.converted;
            if (!pool.some((x) => x.name === name)) return fail(`资源不存在：${name}`, 404);

            const expiresAt = computeExpiry(body.options || {});
            if (snap0.shares.length >= 900) return fail('分享码总量已达上限 900', 429);
            const code = randId(25);
            const { snap } = await mutate(env, (s) => {
                s.shares.push({
                    code,
                    type,
                    name,
                    createdAt: nowIso(),
                    expiresAt,
                    uses: 0,
                });
            });
            return ok({ code, ...snap.shares[snap.shares.length - 1] }, 201);
        }
        if (method === 'DELETE') {
            const code = String(query.get('code') || '');
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.shares.findIndex((x) => x.code === code);
                if (idx < 0) return { error: '分享码不存在', status: 404 };
                s.shares.splice(idx, 1);
                return {};
            });
            if (result.error) return fail(result.error, result.status || 404);
            return ok(snap.shares);
        }
    }

    

    if (seg[0] === 'stats') {
        if (method === 'GET') {
            const stats = await loadStats(env);
            const items = Object.values(stats.items);
            const ips = new Set(items.map((i) => i.ip));
            return ok({
                total: items.reduce((a, b) => a + b.count, 0),
                itemCount: new Set(items.map((i) => `${i.type}|${i.item}`)).size,
                ipCount: ips.size,
                
                
                
                entries: items.length,
                limit: MAX_STATS_ITEMS,
                dropped: Number(stats.dropped) || 0,
                items: items.sort((a, b) => (a.last < b.last ? 1 : -1)),
            });
        }
        if (method === 'DELETE') {
            await clearStats(env);
            return ok({ total: 0, itemCount: 0, ipCount: 0, entries: 0, limit: MAX_STATS_ITEMS, dropped: 0, items: [] });
        }
    }

    

    if (seg[0] === 'settings') {
        if (method === 'GET') {
            const snap = await loadSnapshot(env);
            const ps = publicSettings(snap.settings);
            ps.effectiveBackend = resolveBackend(env, snap.settings);
            ps.envBackend = env.SUB_BACKEND || '';
            return ok(ps);
        }
        if (method === 'POST') {
            const { snap } = await mutate(env, (s) => {
                const cur = s.settings;
                const inc = isPlainObject(body) ? body : {};
                if (typeof inc.subBackend === 'string') cur.subBackend = inc.subBackend.trim();
                if (typeof inc.publicBaseUrl === 'string') cur.publicBaseUrl = inc.publicBaseUrl.trim();
                if (typeof inc.defaultTarget === 'string' && inc.defaultTarget) cur.defaultTarget = inc.defaultTarget;
                if (typeof inc.defaultConfig === 'string') cur.defaultConfig = inc.defaultConfig.trim();

                if (isPlainObject(inc.ai)) {
                    if (typeof inc.ai.baseUrl === 'string') cur.ai.baseUrl = inc.ai.baseUrl.trim();
                    if (typeof inc.ai.model === 'string') cur.ai.model = inc.ai.model.trim();
                    cur.ai.apiKey = mergeSecret(inc.ai.apiKey, cur.ai.apiKey);
                }
                if (isPlainObject(inc.sync)) {
                    if (['none', 'gist', 'webdav'].includes(inc.sync.provider)) {
                        cur.sync.provider = inc.sync.provider;
                    }
                    if (isPlainObject(inc.sync.gist)) {
                        if (typeof inc.sync.gist.gistId === 'string') {
                            cur.sync.gist.gistId = inc.sync.gist.gistId.trim();
                        }
                        cur.sync.gist.token = mergeSecret(inc.sync.gist.token, cur.sync.gist.token);
                    }
                    if (isPlainObject(inc.sync.webdav)) {
                        const w = inc.sync.webdav;
                        if (typeof w.url === 'string') cur.sync.webdav.url = w.url.trim();
                        if (typeof w.user === 'string') cur.sync.webdav.user = w.user.trim();
                        if (typeof w.dir === 'string') cur.sync.webdav.dir = w.dir.trim();
                        cur.sync.webdav.pass = mergeSecret(w.pass, cur.sync.webdav.pass);
                    }
                }
            });
            const ps = publicSettings(snap.settings);
            ps.effectiveBackend = resolveBackend(env, snap.settings);
            ps.envBackend = env.SUB_BACKEND || '';
            return ok(ps);
        }
    }

    

    if (seg[0] === 'backup' && seg[1] === 'export' && method === 'GET') {
        const snap = await loadSnapshot(env);
        const bundle = exportBundle(snap);
        return ok(bundle);
    }

    if (seg[0] === 'backup' && seg[1] === 'import' && method === 'POST') {
        const incoming = body?.bundle ?? body;
        if (!isPlainObject(incoming) || incoming.app !== 'SubPilot') {
            return fail('备份文件格式不匹配（缺少 app: "SubPilot" 标记）', 400);
        }
        
        
        const { result } = await mutate(env, (s) => mergeBundle(s, incoming));
        return ok(result);
    }

    return fail(`未知接口：${method} ${path}`, 404);
}

export function exportableSettings(settings) {
    const s = isPlainObject(settings) ? settings : {};
    const ai = isPlainObject(s.ai) ? s.ai : {};
    const sync = isPlainObject(s.sync) ? s.sync : {};
    const gist = isPlainObject(sync.gist) ? sync.gist : {};
    const dav = isPlainObject(sync.webdav) ? sync.webdav : {};
    const tg = isPlainObject(s.telegram) ? s.telegram : {};
    return {
        subBackend: String(s.subBackend || ''),
        publicBaseUrl: String(s.publicBaseUrl || ''),
        defaultTarget: String(s.defaultTarget || ''),
        defaultConfig: String(s.defaultConfig || ''),
        ai: { baseUrl: String(ai.baseUrl || ''), model: String(ai.model || '') },
        sync: {
            provider: String(sync.provider || 'none'),
            gist: { gistId: String(gist.gistId || '') },
            webdav: {
                url: String(dav.url || ''),
                user: String(dav.user || ''),
                dir: String(dav.dir || ''),
            },
        },
        telegram: {
            chatIds: String(tg.chatIds || ''),
            targets: Array.isArray(tg.targets) ? tg.targets.map((t) => ({ ...t })) : [],
            linkType: String(tg.linkType || ''),
            autoPush: !!tg.autoPush,
        },
    };
}

export function exportBundle(snap) {
    return {
        app: 'SubPilot',
        version: 1,
        exportedAt: nowIso(),
        subs: snap.subs,
        collections: snap.collections,
        files: snap.files,
        converted: snap.converted.map((c) => ({ ...c })),
        
        templates: (snap.templates || []).map((t) => ({ ...t })),
        
        
        settings: exportableSettings(snap.settings),
    };
}

function mergeSettings(cur, inc, stats) {
    if (!isPlainObject(inc)) return 0;
    let n = 0;

    for (const k of ['subBackend', 'publicBaseUrl', 'defaultConfig']) {
        if (typeof inc[k] === 'string') {
            cur[k] = inc[k].trim();
            n += 1;
        }
    }
    if (typeof inc.defaultTarget === 'string' && inc.defaultTarget) {
        cur.defaultTarget = inc.defaultTarget;
        n += 1;
    }

    if (isPlainObject(inc.ai)) {
        for (const k of ['baseUrl', 'model']) {
            if (typeof inc.ai[k] === 'string') {
                cur.ai[k] = inc.ai[k].trim();
                n += 1;
            }
        }
        
    }

    if (isPlainObject(inc.sync)) {
        if (isPlainObject(inc.sync.gist) && typeof inc.sync.gist.gistId === 'string') {
            cur.sync.gist.gistId = inc.sync.gist.gistId.trim();
            n += 1;
        }
        if (isPlainObject(inc.sync.webdav)) {
            for (const k of ['url', 'user', 'dir']) {
                if (typeof inc.sync.webdav[k] === 'string') {
                    cur.sync.webdav[k] = inc.sync.webdav[k].trim();
                    n += 1;
                }
            }
            
        }
        if (['none', 'gist', 'webdav'].includes(inc.sync.provider)) {
            cur.sync.provider = inc.sync.provider;
            n += 1;
            if (cur.sync.provider === 'gist' && !cur.sync.gist.token) {
                stats.warnings.push(
                    '备份把同步通道设为 Gist，但本机没有 Gist Token（凭据不进备份），需在同步页补填后才能备份',
                );
            }
            if (cur.sync.provider === 'webdav' && !cur.sync.webdav.pass) {
                stats.warnings.push(
                    '备份把同步通道设为 WebDAV；若该网盘需要密码，请在同步页补填（凭据不进备份）',
                );
            }
        }
    }

    if (isPlainObject(inc.telegram)) {
        const tg = inc.telegram;
        for (const k of ['chatIds', 'linkType']) {
            if (typeof tg[k] === 'string') {
                cur.telegram[k] = tg[k].trim();
                n += 1;
            }
        }
        if (typeof tg.autoPush === 'boolean') {
            cur.telegram.autoPush = tg.autoPush;
            n += 1;
        }
        if (Array.isArray(tg.targets)) {
            
            cur.telegram.targets = tg.targets
                .filter(
                    (t) =>
                        isPlainObject(t) &&
                        ['sub', 'col', 'file'].includes(t.kind) &&
                        typeof t.name === 'string' &&
                        t.name,
                )
                .map((t) => ({ kind: t.kind, name: t.name }));
            n += 1;
        }
        
    }

    return n;
}

export function mergeBundle(snap, incoming) {
    const stats = { added: 0, updated: 0, skipped: 0, settingsUpdated: 0, warnings: [] };

    
    const guard = (item, kind, { maxLen = 0 } = {}) => {
        const nameErr = validateName(item.name, { maxLen });
        if (nameErr) {
            stats.warnings.push(`跳过一条${kind}：${nameErr}（${String(item.name).slice(0, 40)}）`);
            return false;
        }
        return true;
    };

    
    const guardProcess = (item) => {
        if (item.process === undefined) return true;
        const clean = sanitizeProcess(item.process);
        if (clean) {
            item.process = clean;
            return true;
        }
        item.process = [];
        stats.warnings.push(`「${item.name}」的算子链结构不合法，已清空`);
        return true;
    };

    const mergeList = (target, source, fields, prepare) => {
        for (const raw of Array.isArray(source) ? source : []) {
            if (!isPlainObject(raw) || !raw.name) {
                stats.skipped += 1;
                continue;
            }
            const item = pick(raw, fields);
            item.name = String(raw.name).trim();
            if (prepare && !prepare(item)) {
                stats.skipped += 1;
                continue;
            }
            const idx = target.findIndex((x) => x.name === item.name);
            if (idx < 0) {
                target.push({ ...item, createdAt: raw.createdAt || nowIso(), updatedAt: nowIso() });
                stats.added += 1;
            } else {
                target[idx] = { ...target[idx], ...item, updatedAt: nowIso() };
                stats.updated += 1;
            }
        }
    };

    mergeList(snap.subs, incoming.subs, SUB_FIELDS, (item) => {
        if (!guard(item, '订阅')) return false;
        const size = fileBytes(item.content);
        if (size > MAX_SUB_BYTES) {
            stats.warnings.push(`跳过订阅「${item.name}」：正文约 ${fmtBytes(size)}，超过 8MiB 上限`);
            return false;
        }
        
        
        
        
        if (item.source !== 'local') item.content = '';
        return guardProcess(item);
    });

    mergeList(snap.collections, incoming.collections, COL_FIELDS, (item) => {
        if (!guard(item, '组合')) return false;
        return guardProcess(item);
    });

    mergeList(snap.files, incoming.files, FILE_FIELDS, (item) => {
        if (!guard(item, '文件')) return false;
        const size = fileBytes(item.content);
        if (size > MAX_FILE_BYTES) {
            stats.warnings.push(`跳过文件「${item.name}」：正文约 ${fmtBytes(size)}，超过 512KiB 上限`);
            return false;
        }
        
        if (item.source === 'remote') item.content = '';
        return true;
    });

    mergeList(
        snap.converted,
        incoming.converted,
        ['name', 'target', 'template', 'content', 'createdAt'],
        (item) => guard(item, '成品卡', { maxLen: 64 }),
    );

    
    mergeList(snap.templates, incoming.templates, ['name', 'desc', 'process'], (item) => {
        if (!guard(item, '模板', { maxLen: 40 })) return false;
        const clean = sanitizeProcess(item.process);
        if (!clean) {
            stats.warnings.push(`模板「${item.name}」的算子链结构不合法，已跳过`);
            return false;
        }
        item.process = clean;
        item.desc = String(item.desc ?? '').trim().slice(0, 200);
        return true;
    });

    
    stats.settingsUpdated = mergeSettings(snap.settings, incoming.settings, stats);

    
    
    const builtin = new Set(PROCESS_PRESETS.map((p) => p.name));
    const collided = snap.templates.filter((t) => builtin.has(t.name)).map((t) => t.name);
    if (collided.length) {
        snap.templates = snap.templates.filter((t) => !builtin.has(t.name));
        stats.skipped += collided.length;
        stats.warnings.push(`以下自定义模板与内置模板重名，已跳过：${collided.join('、')}`);
    }

    
    const subNames = new Set(snap.subs.map((s) => s.name));
    for (const c of snap.collections) {
        const missing = (c.subscriptions || []).filter((n) => !subNames.has(n));
        if (missing.length) {
            stats.warnings.push(`组合「${c.name}」引用了不存在的订阅：${missing.join('、')}`);
        }
    }
    return stats;
}

function normalizeSub(input, prev = {}) {
    const source = input.source === 'local' ? 'local' : 'remote';
    const content = source === 'local' ? String(input.content ?? prev.content ?? '') : '';

    
    
    
    
    const size = fileBytes(content);
    if (size > MAX_SUB_BYTES) {
        const name = String(input.name ?? prev.name ?? '').trim();
        throw new ApiError(`订阅「${name}」正文超过 8MiB 上限（当前约 ${fmtBytes(size)}）`, 413);
    }

    return {
        name: String(input.name ?? prev.name ?? '').trim(),
        displayName: String(input.displayName ?? prev.displayName ?? '').trim(),
        source,
        url: source === 'remote' ? String(input.url ?? prev.url ?? '') : '',
        content,
        ua: String(input.ua ?? prev.ua ?? '').trim(),
        remark: String(input.remark ?? prev.remark ?? '').trim(),
        process: Array.isArray(input.process) ? input.process : prev.process || [],
        createdAt: prev.createdAt || nowIso(),
        updatedAt: nowIso(),
    };
}

function validateSub(body) {
    const nameErr = validateName(body?.name);
    if (nameErr) return nameErr;
    
    const size = fileBytes(body?.content);
    if (size > MAX_SUB_BYTES) {
        return `订阅正文超过 8MiB 上限（当前约 ${fmtBytes(size)}）`;
    }
    if (body?.source === 'local') {
        if (!String(body.content || '').trim()) return '本地订阅需要填写节点内容';
    } else if (!String(body?.url || '').trim()) {
        return '远程订阅需要填写订阅地址';
    }
    if (body?.process !== undefined && !Array.isArray(body.process)) {
        return '算子链必须是数组';
    }
    return '';
}

function normalizeCol(input, prev = {}) {
    const subs = Array.isArray(input.subscriptions)
        ? input.subscriptions.map((x) => String(x)).filter(Boolean)
        : prev.subscriptions || [];
    return {
        name: String(input.name ?? prev.name ?? '').trim(),
        displayName: String(input.displayName ?? prev.displayName ?? '').trim(),
        subscriptions: [...new Set(subs)],
        process: Array.isArray(input.process) ? input.process : prev.process || [],
        remark: String(input.remark ?? prev.remark ?? '').trim(),
        createdAt: prev.createdAt || nowIso(),
        updatedAt: nowIso(),
    };
}

function validateCol(body) {
    const err = validateName(body?.name);
    if (err) return err;
    if (!Array.isArray(body?.subscriptions) || !body.subscriptions.length) {
        return '请至少选择一个订阅';
    }
    if (body.process !== undefined && !Array.isArray(body.process)) return '算子链必须是数组';
    return '';
}

function normalizeFile(input, prev = {}) {
    const source = input.source === 'remote' ? 'remote' : 'local';
    return {
        name: String(input.name ?? prev.name ?? '').trim(),
        displayName: String(input.displayName ?? prev.displayName ?? '').trim(),
        source,
        url: source === 'remote' ? String(input.url ?? prev.url ?? '') : '',
        content: source === 'local' ? String(input.content ?? prev.content ?? '') : '',
        createdAt: prev.createdAt || nowIso(),
        updatedAt: nowIso(),
    };
}

function validateFile(body) {
    const err = validateName(body?.name);
    if (err) return err;
    const ext = extOf(body?.name);
    if (ext && !ALLOWED_FILE_EXT.includes(ext)) {
        return `不支持的文件类型 .${ext}（允许：${ALLOWED_FILE_EXT.join(' ')}）`;
    }
    const size = fileBytes(body?.content);
    if (size > MAX_FILE_BYTES) return `文件超过 512KB 上限（当前约 ${Math.round(size / 1024)}KB）`;
    if (body?.source === 'remote') {
        const u = String(body?.url || '').trim();
        if (!u) return '远程文件需要填写地址';
        
        
        if (!/^https?:\/\//i.test(u)) return '远程文件地址必须以 http:// 或 https:// 开头';
    }
    return '';
}

export function extOf(name) {
    const base = String(name || '').split(/[?#]/)[0];
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot === base.length - 1) return '';
    const ext = base.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function computeExpiry(options) {
    const kind = options.kind || 'days';
    if (kind === 'never') return '';
    if (kind === 'date') {
        const d = String(options.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
        
        return new Date(`${d}T23:59:59`).toISOString();
    }
    const days = Math.max(1, parseInt(options.days, 10) || 7);
    return new Date(Date.now() + days * 86400_000).toISOString();
}
