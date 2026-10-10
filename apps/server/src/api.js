// /api/* 的 REST 处理器。
//
// 约定（很重要，前端依赖它）：
//   **集合类写操作**（订阅 / 组合 / 文件 / 成品 / 模板）返回
//   `{ status:'success', data: <更新后的完整集合> }`。
//   前端直接用返回值覆盖本地状态，因此不受 KV 最终一致性的影响 ——
//   写完立刻读也不会读到旧数据。读接口只用于首次加载与跨设备刷新。
//
//   少数写操作返回的是**该动作自身的局部结果**，不是集合：
//     · POST /api/shares        → 新建的那一条分享码
//     · POST /api/feedkey/rotate→ { rotatedAt }
//     · POST /api/settings      → 脱敏后的设置对象
//     · POST /api/backup/import → 合并统计 { added, updated, skipped, warnings }
//   这些操作不影响前端缓存的集合，所以不套用上面那条约定。

import { ok, fail, isPlainObject, validateName, toStringArray, pick, nowIso, randId, maskSecret } from './util.js';
import { loadSnapshot, mutate, loadStats, clearStats } from './storage.js';
import { resolveBackend, probeBackend, SCE_TARGETS } from './sce.js';
import { runPipeline, previewText, fetchSubText } from './pipeline.js';
import { buildLinks, resolveSourceRefs, adhocSpec } from './convert.js';
import { OPERATOR_TYPES, PROCESS_PRESETS } from './operators.js';
import { handleTemplates } from './templates.js';
// 版本号单一事实来源 = apps/server/package.json。
// 之前在 utils/env 里硬编码 '0.1.0'，升 package.json 版本号它纹丝不动
// （左下角一直 v0.1.0 的 bug 就这么来的）。wrangler/esbuild 打包时会把
// JSON 内联；Node 直跑（server.mjs）需要 import attributes，Node 20.10+ 支持。
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

// ---------------------------------------------------------------- 小工具

/**
 * 文件正文的**字节数**。
 * 必须和 MAX_FILE_BYTES 同口径 —— 用 String.length 数的是 UTF-16 码元，
 * 一份全中文的 JSON 会被低估到实际体积的 1/3，于是「512KB 上限」形同虚设。
 */
function fileBytes(content) {
    return new TextEncoder().encode(String(content ?? '')).length;
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

/** 数组集合的排序落库：body 是名称数组，未列出的排在后面（保持相对顺序） */
function applyOrder(list, names) {
    const index = new Map(names.map((n, i) => [n, i]));
    return [...list].sort((a, b) => {
        const ia = index.has(a.name) ? index.get(a.name) : Number.MAX_SAFE_INTEGER;
        const ib = index.has(b.name) ? index.get(b.name) : Number.MAX_SAFE_INTEGER;
        return ia - ib;
    });
}

// ---------------------------------------------------------------- 成品的固定分享链接

/**
 * 保证某个成品有一条**固定**的分享链接（就地改传入的 snapshot，不落库 —— 由调用方的 mutate 负责）。
 *
 * 为什么成品不用「点一次生成一次」那套：
 * 成品的链接会被嵌进客户端配置长期使用。若每次重新转换保存都换一条新码，
 * 所有人手里的订阅都会在某天突然失效，还得重新分发一遍。
 * 所以成品的链接是「保存即定下、之后永不变」的。
 *
 * 幂等语义（这是本函数的关键）：
 *   ① 已经有一条 → **原样复用它的 code**，URL 不变；
 *   ② 有多条（历史遗留，以前每个成品可以点多次「生成链接」）→ 只保留**最早的那条**
 *      （最可能已经被分发出去，删它比删新的更安全），其余回收；
 *   ③ 一条都没有 → 新建一条。
 *
 * 顺手把 `expiresAt` 归一成 null：固定链接不能自己到期，
 * 否则「不变」只是假象 —— 某天客户端会突然拉不到，而且没人会想到是链接过期了。
 */
function ensureConvertedShare(s, name) {
    const mine = (s.shares || []).filter((sh) => sh.type === 'converted' && sh.name === name);
    if (!mine.length) {
        const code = randId(25);
        s.shares.push({ code, type: 'converted', name, createdAt: nowIso(), expiresAt: null, uses: 0 });
        return code;
    }
    // 按创建时间取最早的一条；时间相同（或缺失）时退化为数组顺序，保证结果稳定
    const keep = mine.reduce((a, b) => ((a.createdAt || '') <= (b.createdAt || '') ? a : b));
    keep.expiresAt = null;
    if (mine.length > 1) {
        const drop = new Set(mine.filter((x) => x !== keep).map((x) => x.code));
        s.shares = s.shares.filter((sh) => !drop.has(sh.code));
    }
    return keep.code;
}

/**
 * 给成品列表项补上 `shareCode`。
 *
 * 前端要的是「卡片上直接显示链接」，所以码必须跟着列表一起来 ——
 * 否则每渲染一次卡片都得再拉一遍 /api/shares，多一次往返还容易读到旧快照。
 */
function withShareCode(snap, { content, ...rest }) {
    const hit = (snap.shares || []).find((sh) => sh.type === 'converted' && sh.name === rest.name);
    return { ...rest, size: fileBytes(content), shareCode: hit?.code || '' };
}

/** 对外暴露设置时抹掉密钥，只回 has* 标记 */
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
    // TG 的 bot token 同样是凭据。publicSettings 被 /api/settings 和备份导出共用，
    // 这里漏一遍，明文就会从唯一的下发口流出去 —— 而且备份文件还会带着它跑。
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

// maskSecret 已统一到 util.js —— 此前这里和 telegram.js 各有一套（4+4 与 6+4），
// 同一个凭据在两页显示出的掩码不同。见 util.js 的说明。

/** 合并设置：空串 / 掩码占位符 = 保留原值（用户没改这一项） */
function mergeSecret(incoming, current) {
    if (typeof incoming !== 'string') return current;
    const t = incoming.trim();
    if (!t || t.includes('****')) return current;
    return t;
}

// ---------------------------------------------------------------- 处理器

export async function handleApi(request, env, ctx, { method, path, query }) {
    const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);

    // ---- 环境 / 元数据 ----

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
        // templates = 用户自定义模板。内置预设放在 presets 里（代码常量，不落库）。
        // 编辑器一次请求就能把「类型表 + 内置模板 + 自定义模板」全拿到。
        const snap = await loadSnapshot(env);
        return ok({
            types: OPERATOR_TYPES,
            presets: PROCESS_PRESETS,
            templates: snap.templates,
            targets: SCE_TARGETS,
        });
    }

    // ---- 自定义模板 ----
    if (seg[0] === 'templates' || seg[0] === 'template') {
        return handleTemplates(env, { method, seg, body });
    }

    // ---- 分发链接 ----

    if (seg[0] === 'link' && method === 'GET') {
        const kind = query.get('kind') === 'col' ? 'col' : 'sub';
        const name = String(query.get('name') || '');
        const target = String(query.get('target') || '');
        const snap = await loadSnapshot(env);
        const pool = kind === 'col' ? snap.collections : snap.subs;
        if (!pool.some((x) => x.name === name)) return fail(`资源不存在：${name}`, 404);
        return ok(await buildLinks(request, env, snap, { kind, name, target }));
    }

    // 多来源临时选择的分发链接：转换页勾了 2 个以上来源时用。
    // 这组选择没有名字可以寻址，所以后端把它折成一个 adhoc spec，
    // 再走和单来源同一套派生密钥 —— 不占分享码，也不需要落库。
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

    // 轮换分发密钥：让所有已发出的 /feed、/download 链接立即失效
    if (seg[0] === 'feedkey' && seg[1] === 'rotate' && method === 'POST') {
        const { snap } = await mutate(env, (s) => {
            s.settings.feedSalt = randId(24);
            s.settings.feedSaltCreatedAt = nowIso();
        });
        return ok({ rotatedAt: snap.settings.feedSaltCreatedAt });
    }

    // ---- 订阅 ----

    if (seg[0] === 'subs' && method === 'GET') {
        const snap = await loadSnapshot(env);
        return ok(snap.subs);
    }

    if (seg[0] === 'subs' && method === 'POST') {
        const err = validateSub(body);
        if (err) return fail(err, 400);
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
                const merged = normalizeSub({ ...s.subs[idx], ...pick(body, SUB_FIELDS) }, s.subs[idx]);
                merged.name = name; // 改名走单独的 rename 接口
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
                // 主动把该名称从所有组合里摘掉，避免留下悬空引用
                let touched = 0;
                for (const c of s.collections) {
                    const before = c.subscriptions.length;
                    c.subscriptions = c.subscriptions.filter((n) => n !== name);
                    if (c.subscriptions.length !== before) touched += 1;
                }
                // 顺带回收该订阅的分享码
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
            // 组合按名称引用，改名后要跟着改
            let touched = 0;
            for (const c of s.collections) {
                const i = c.subscriptions.indexOf(oldName);
                if (i >= 0) {
                    c.subscriptions[i] = newName;
                    touched += 1;
                }
            }
            // 分享码里的名称同步更新，否则旧分享链接会指向不存在的订阅
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

    // ---- 组合 ----

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

    // ---- 文件 ----

    if (seg[0] === 'files' && method === 'GET') {
        const snap = await loadSnapshot(env);
        // 列表不带正文，避免一次拉几百 KB
        return ok(snap.files.map(({ content, ...rest }) => ({ ...rest, size: fileBytes(content) })));
    }

    // 单个文件的完整记录（含正文）。路径段用单数 file，与集合 /api/files 并列；
    // 此前叫 wholeFile，是全站唯一一处 camelCase 路径段。
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
                if (newName !== name) {
                    const nerr = validateFile({ ...s.files[idx], name: newName, content: 'x' });
                    if (nerr) return { error: nerr, status: 400 };
                    if (s.files.some((f) => f.name === newName)) {
                        return { error: `名称已被占用：${newName}`, status: 409 };
                    }
                }
                const merged = normalizeFile({ ...s.files[idx], ...incoming }, s.files[idx]);
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

    // ---- 预览 ----

    if (seg[0] === 'preview' && seg[1] === 'sub' && method === 'POST') {
        const sub = normalizeSub(body);
        try {
            let text = '';
            if (sub.source === 'local') text = sub.content || '';
            else {
                const urls = toStringArray(sub.url);
                if (!urls.length) return fail('请先填写订阅地址', 400);
                const chunks = [];
                for (const u of urls) chunks.push(await fetchSubText(u, sub.ua));
                text = chunks.join('\n');
            }
            const r = previewText(text, sub.process);
            return ok({ format: r.format, processed: r.summary, log: r.log, total: r.summary.length });
        } catch (e) {
            return fail(e.message, 400);
        }
    }

    if (seg[0] === 'preview' && seg[1] === 'process' && method === 'POST') {
        // 脚本处理页的实时预览：可以贴正文，也可以给一个远程地址
        const process = Array.isArray(body.process) ? body.process : [];
        try {
            let text = String(body.content || '');
            if (!text && body.url) text = await fetchSubText(String(body.url), String(body.ua || ''));
            if (!text) return fail('请提供订阅内容或地址', 400);
            const r = previewText(text, process);
            return ok({ format: r.format, processed: r.summary, log: r.log, total: r.summary.length });
        } catch (e) {
            return fail(e.message, 400);
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
            return fail(e.message, 400);
        }
    }

    // ---- 成品卡 ----

    if (seg[0] === 'converted') {
        if (method === 'GET' && seg.length === 1) {
            const snap = await loadSnapshot(env);
            // 老成品可能没有分享码（「保存即分发」机制上线前保存的）——
            // 列表时顺手补建。ensureConvertedShare 幂等：已有码的成品原样保留。
            const missing = snap.converted.some(
                (c) => !(snap.shares || []).some((sh) => sh.type === 'converted' && sh.name === c.name),
            );
            if (missing) {
                const { snap: s2 } = await mutate(env, (s) => {
                    for (const c of s.converted) ensureConvertedShare(s, c.name);
                });
                return ok(s2.converted.map((c) => withShareCode(s2, c)));
            }
            return ok(snap.converted.map((c) => withShareCode(snap, c)));
        }
        if (method === 'POST') {
            const name = String(body.name || '').trim();
            const nameErr = validateName(name, { maxLen: 64 });
            if (nameErr) return fail(`成品${nameErr}`, 400);
            if (typeof body.content !== 'string' || !body.content) return fail('成品内容为空', 400);
            const bytes = new TextEncoder().encode(body.content).length;
            if (bytes > 16 * 1024 * 1024) return fail('成品内容超过 16MiB 上限', 413);
            const { snap } = await mutate(env, (s) => {
                const idx = s.converted.findIndex((c) => c.name === name);
                const item = {
                    name,
                    target: String(body.target || ''),
                    template: String(body.template || ''),
                    content: body.content,
                    createdAt: idx >= 0 ? s.converted[idx].createdAt : nowIso(),
                    updatedAt: nowIso(),
                };
                if (idx >= 0) s.converted[idx] = item;
                else s.converted.unshift(item);
                // 保存即分发：链接在这一步就定下来，之后重转重存都不会变
                ensureConvertedShare(s, name);
            });
            return ok(snap.converted.map((c) => withShareCode(snap, c)), 201);
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
                    // 顺带回收该成品的分享码，否则 /api/shares 里会留下指向空资源的死链
                    s.shares = s.shares.filter((sh) => !(sh.type === 'converted' && sh.name === name));
                    return {};
                });
                if (result.error) return fail(result.error, result.status || 404);
                return ok(s2.converted.map((c) => withShareCode(s2, c)));
            }
        }
    }

    // ---- 分享码 ----

    if (seg[0] === 'shares') {
        if (method === 'GET') {
            const snap = await loadSnapshot(env);
            return ok([...snap.shares].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
        }
        if (method === 'POST') {
            const type = String(body.type || '');
            // converted（转换成品）也能分享：它就是一份已生成的最终产物，
            // /share/converted/… 直接把它原样吐出去，不需要再走一次转换。
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

    // ---- 统计 ----

    if (seg[0] === 'stats') {
        if (method === 'GET') {
            const stats = await loadStats(env);
            const items = Object.values(stats.items);
            const ips = new Set(items.map((i) => i.ip));
            return ok({
                total: items.reduce((a, b) => a + b.count, 0),
                itemCount: new Set(items.map((i) => `${i.type}|${i.item}`)).size,
                ipCount: ips.size,
                items: items.sort((a, b) => (a.last < b.last ? 1 : -1)),
            });
        }
        if (method === 'DELETE') {
            await clearStats(env);
            return ok({ total: 0, itemCount: 0, ipCount: 0, items: [] });
        }
    }

    // ---- 设置 ----

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

    // ---- 备份导入 / 导出（本地通道，不依赖 Gist / WebDAV）----

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
        // mutate() 内部已经写过一次 KV，这里不要再写第二遍 ——
        // 快照是单键整包序列化，重复写等于把每次导入的耗时翻倍，收益为零。
        const { result } = await mutate(env, (s) => mergeBundle(s, incoming));
        return ok(result);
    }

    return fail(`未知接口：${method} ${path}`, 404);
}

// ---------------------------------------------------------------- 备份结构

export function exportBundle(snap) {
    return {
        app: 'SubPilot',
        version: 1,
        exportedAt: nowIso(),
        subs: snap.subs,
        collections: snap.collections,
        files: snap.files,
        converted: snap.converted.map((c) => ({ ...c })),
        // 自定义算子模板一起带走 —— 它是用户手调的成果，丢了比丢一条订阅更烦
        templates: (snap.templates || []).map((t) => ({ ...t })),
        // 设置不含密钥，避免备份文件变成凭据泄漏渠道
        settings: publicSettings(snap.settings),
    };
}

/**
 * 合并备份：按 name 合并，**同名以云端/导入文件为准**，本站多余项保留。
 * 是合并而非覆盖 —— 覆盖会静默丢掉用户在本站新建的内容。
 */
export function mergeBundle(snap, incoming) {
    const stats = { added: 0, updated: 0, skipped: 0, warnings: [] };

    const mergeList = (target, source, fields) => {
        for (const raw of Array.isArray(source) ? source : []) {
            if (!isPlainObject(raw) || !raw.name) {
                stats.skipped += 1;
                continue;
            }
            const item = pick(raw, fields);
            const idx = target.findIndex((x) => x.name === raw.name);
            if (idx < 0) {
                target.push({ ...item, createdAt: raw.createdAt || nowIso(), updatedAt: nowIso() });
                stats.added += 1;
            } else {
                target[idx] = { ...target[idx], ...item, updatedAt: nowIso() };
                stats.updated += 1;
            }
        }
    };

    mergeList(snap.subs, incoming.subs, SUB_FIELDS);
    mergeList(snap.collections, incoming.collections, COL_FIELDS);
    mergeList(snap.files, incoming.files, FILE_FIELDS);
    mergeList(snap.converted, incoming.converted, ['name', 'target', 'template', 'content', 'createdAt']);
    mergeList(snap.templates, incoming.templates, ['name', 'desc', 'process']);

    // 导入的模板可能撞上内置模板名（对方版本不同、或手工改过备份文件）。
    // 留着会导致下拉里出现两个同名项，套用哪个全凭运气 —— 直接剔除并告知。
    const builtin = new Set(PROCESS_PRESETS.map((p) => p.name));
    const collided = snap.templates.filter((t) => builtin.has(t.name)).map((t) => t.name);
    if (collided.length) {
        snap.templates = snap.templates.filter((t) => !builtin.has(t.name));
        stats.skipped += collided.length;
        stats.warnings.push(`以下自定义模板与内置模板重名，已跳过：${collided.join('、')}`);
    }

    // 悬空引用检查：组合里引用了不存在的订阅时明确列出来，别让它悄悄坏掉
    const subNames = new Set(snap.subs.map((s) => s.name));
    for (const c of snap.collections) {
        const missing = (c.subscriptions || []).filter((n) => !subNames.has(n));
        if (missing.length) {
            stats.warnings.push(`组合「${c.name}」引用了不存在的订阅：${missing.join('、')}`);
        }
    }
    return stats;
}

// ---------------------------------------------------------------- 归一化 / 校验

function normalizeSub(input, prev = {}) {
    const source = input.source === 'local' ? 'local' : 'remote';
    return {
        name: String(input.name ?? prev.name ?? '').trim(),
        displayName: String(input.displayName ?? prev.displayName ?? '').trim(),
        source,
        url: source === 'remote' ? String(input.url ?? prev.url ?? '') : '',
        content: source === 'local' ? String(input.content ?? prev.content ?? '') : '',
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
    if (body?.source === 'remote' && !String(body?.url || '').trim()) {
        return '远程文件需要填写地址';
    }
    return '';
}

/** 取扩展名；无扩展名或扩展名超过 8 位非字母数字一律视为无扩展名 */
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
        // 当天 23:59:59 失效
        return new Date(`${d}T23:59:59`).toISOString();
    }
    const days = Math.max(1, parseInt(options.days, 10) || 7);
    return new Date(Date.now() + days * 86400_000).toISOString();
}
