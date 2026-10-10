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
//     · POST /api/backup/import → 合并统计 { added, updated, skipped, settingsUpdated, warnings }
//   这些操作不影响前端缓存的集合，所以不套用上面那条约定。

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

/**
 * 本地订阅正文上限（审计 M5）。
 *
 * 此前只有文件和成品有上限（512KiB / 16MiB），**唯独订阅正文是敞开的** ——
 * 而它恰恰是最容易被塞进大东西的地方（机场节点列表、整份规则集）。
 * Cloudflare KV 单个 value 上限 25MiB，快照是「几个数组 + 一份设置」整包序列化，
 * 一条超限订阅就足以让 `writeSnapshot` 失败 → `mutate()` 抛异常 → 该次写操作 500，
 * 而且失败点可能在业务逻辑已执行之后，观感是「提示失败但部分状态已变」。
 *
 * 取 8MiB：比成品（16MiB）小一档，因为快照里装的是**所有**订阅之和；
 * 又比文件（512KiB）大一档，因为真实订阅正文经常有几 MB。
 */
const MAX_SUB_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- 小工具

/**
 * 文件正文的**字节数**。
 * 必须和 MAX_FILE_BYTES 同口径 —— 用 String.length 数的是 UTF-16 码元，
 * 一份全中文的 JSON 会被低估到实际体积的 1/3，于是「512KB 上限」形同虚设。
 */
function fileBytes(content) {
    return new TextEncoder().encode(String(content ?? '')).length;
}

/** 人类可读的体积，用于报错文案（不追求精确，够用户判断「超了多少」） */
function fmtBytes(n) {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MiB`;
    if (n >= 1024) return `${Math.round(n / 1024)}KiB`;
    return `${n}B`;
}

/** 订阅正文超限用 413，其余校验失败用 400 —— 前端据此区分提示语气 */
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
 * 给成品列表项补上 `shareCode` 与 `link`。
 *
 * 前端要的是「卡片上直接显示 / 复制链接」，所以两者必须跟着列表一起来 ——
 * 否则每渲染一次卡片都得再拉一遍 /api/shares，多一次往返还容易读到旧快照。
 *
 * `link` 是**成品链接**（转换后端格式的快照链，见 convert.js 的
 * convertedBackendLink），也就是成品卡片上「⧉ 分享链接」复制出来的那条；
 * TG 推送成品时用的是同一个函数产出的地址，两边不可能漂移。
 */
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
                // 校验**合并后的结果**，不是请求体（审计 M5，与 PATCH /api/file 同款缺口）：
                // 「只改备注」的请求里没有 content，但库里那条本身可能已经超限；
                // 「把远程订阅改成 local 再贴上 30MiB 正文」更是从请求体的字面看不出来。
                const verr = validateSub({ ...mergedInput, name });
                if (verr) return { error: verr, status: subErrorStatus(mergedInput) };
                const merged = normalizeSub(mergedInput, s.subs[idx]);
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
                if (newName !== name && s.files.some((f) => f.name === newName)) {
                    return { error: `名称已被占用：${newName}`, status: 409 };
                }
                const merged = normalizeFile(
                    { ...s.files[idx], ...incoming, name: newName },
                    s.files[idx],
                );
                // 校验**合并后的结果**，不能只在改名时校验。
                // 之前这里只在 newName !== name 时调 validateFile，于是「不改名」的
                // PATCH 完全跳过校验 —— 扩展名白名单、512KB 上限、以及审计 L2 的
                // 远程地址协议限制，全都能用一个同名的 PATCH 绕过去（实测：
                // PATCH {source:'remote', url:'javascript:alert(1)'} 会被原样存下）。
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

    // ---- 预览 ----

    if (seg[0] === 'preview' && seg[1] === 'sub' && method === 'POST') {
        // normalizeSub 放在 try 里面：它现在会因为正文超限抛 ApiError（审计 M5），
        // 抛在外面就没有对应的 catch，会被入口翻成 500。
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
        // 脚本处理页的实时预览：可以贴正文，也可以给一个远程地址
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
                    // 顺带回收该成品的分享码，否则 /api/shares 里会留下指向空资源的死链
                    s.shares = s.shares.filter((sh) => !(sh.type === 'converted' && sh.name === name));
                    return {};
                });
                if (result.error) return fail(result.error, result.status || 404);
                return ok(s2.converted.map((c) => withShareCode(s2, c, { request, env })));
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
                // 上限可见化（审计 M5）：条目数长期贴着上限时，用户需要知道
                // 「记录被裁剪过」。没有这两个字段的话，数据莫名变少只会让人
                // 以为是 bug，而不是「到上限了」。
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

/**
 * 可进备份的设置子集（审计 L3）。
 *
 * 与 `publicSettings` 的区别在**用途**：后者是「给前端看的」，凭据字段被换成
 * `hasApiKey` / `tokenSet` / `*Mask` 之类的标记，值全丢了 —— 拿它当备份内容，
 * 导入时能恢复的信息量为零（这正是审计 L3 说的「导出了但从不恢复」）。
 * 这里要的是「能原样恢复的一份子集」：不含任何凭据，但字段值是真的。
 *
 * 为什么不干脆把凭据也导出去：备份会落到 Gist / 网盘 / 用户下载的 JSON 里，
 * 那等于把 AI Key、Bot Token、网盘密码复制到几个不受控的地方。所以凭据一律
 * 不进备份，导入侧对这几个字段**保持本机现值不动**。
 *
 * 明确排除：
 *   · feedSalt（轮换它会让所有已发出的 /feed、/download 链接立即失效）
 *   · ai.apiKey / sync.gist.token / sync.webdav.pass / telegram.token
 *   · telegram.lastPush（运行态，不是配置）
 */
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
        // 自定义算子模板一起带走 —— 它是用户手调的成果，丢了比丢一条订阅更烦
        templates: (snap.templates || []).map((t) => ({ ...t })),
        // 设置里的**非凭据**字段一起带走，导入时按字段合并（审计 L3）。
        // 凭据（AI Key / Gist Token / 网盘密码 / Bot Token）永不进备份。
        settings: exportableSettings(snap.settings),
    };
}

/**
 * 按字段合并设置（审计 L3）。只认非凭据字段，凭据一律不动本机现值。
 *
 * `provider` 是个例外：它本身不是凭据，但切过去之后依赖对应凭据存在。
 * 所以切完要检查本机有没有那个凭据，没有就明确警告 —— 否则用户会看到
 * 「自动同步已开启」却一直失败，还以为是网络问题。
 *
 * @returns {number} 实际写入的字段数
 */
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
        // apiKey 不在备份里，保持本机现值
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
            // pass 不在备份里，保持本机现值
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
            // 只收合法形状：导入文件是外部输入，别让脏数据进到推送循环里
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
        // token 不在备份里，保持本机现值
    }

    return n;
}

/**
 * 合并备份：按 name 合并，**同名以云端/导入文件为准**，本站多余项保留。
 * 是合并而非覆盖 —— 覆盖会静默丢掉用户在本站新建的内容。
 *
 * 除了五张表，现在还合并**设置里的非凭据字段**（审计 L3）：导出侧给的是
 * exportableSettings() 的结果，导入侧对凭据（AI Key / Gist Token / 网盘密码 /
 * Bot Token）保持本机现值不动 —— 备份文件不该成为凭据副本。
 */
export function mergeBundle(snap, incoming) {
    const stats = { added: 0, updated: 0, skipped: 0, settingsUpdated: 0, warnings: [] };

    /**
     * 导入项的统一净化。
     *
     * 备份文件是**外部输入**：可能来自旧版本，可能是手工改过的 JSON，也可能
     * 干脆是别人给的。而写入路径有 validateSub / validateFile / sanitizeProcess
     * 把关，导入路径此前一个都没有（审计 L3 / M5）—— 一份坏备份能直接落库，
     * 落进去之后每次保存都要把这份脏数据再写一遍。
     *
     * 这里统一处理三类问题：名称非法（会破坏 URL 路径语义）、正文超限
     * （KV 单值 25MiB，超了就是整个快照写失败）、算子链结构不合法。
     * 一律**跳过 + 记一条 warning**，不静默丢弃。
     */
    const guard = (item, kind, { maxLen = 0 } = {}) => {
        const nameErr = validateName(item.name, { maxLen });
        if (nameErr) {
            stats.warnings.push(`跳过一条${kind}：${nameErr}（${String(item.name).slice(0, 40)}）`);
            return false;
        }
        return true;
    };

    /** 算子链净化：结构不合法就清空（运行时 applyOperators 会跳过非法项，但别让它进库） */
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
        // 与写入路径（normalizeSub）同语义：远程订阅的正文一律清空。不收敛的话，
        // 一份把节点正文塞进远程订阅的备份会把它原样带进来 —— 白占体积，
        // 还会让「远程订阅只备份地址，不缓存节点正文」这条说明变成假话。
        // 赋空串而不是 delete 键：记录形状要和 normalizeSub 产出的完全一致。
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
        // 同上：远程文件不存正文（normalizeFile 的 source 缺省是 local，所以按 remote 判）
        if (item.source === 'remote') item.content = '';
        return true;
    });

    mergeList(
        snap.converted,
        incoming.converted,
        ['name', 'target', 'template', 'content', 'createdAt'],
        (item) => guard(item, '成品卡', { maxLen: 64 }),
    );

    // 模板的算子链**必须**合法：它是「用户手调的成果」，进来一条坏链子还不如没有
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

    // 设置按字段合并（审计 L3）：导出侧给的是非凭据子集，导入侧对凭据保持本机现值
    stats.settingsUpdated = mergeSettings(snap.settings, incoming.settings, stats);

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
    const content = source === 'local' ? String(input.content ?? prev.content ?? '') : '';

    // 第二道闸（审计 M5）。validateSub 是第一道，走 API 的正常路径到不了这里；
    // 但**备份导入**以及将来新增的调用点都可能绕过它。与其静默写进一份超限正文
    // （KV 单值 25MiB，超了就是整个快照写失败），不如在这里直接抛 —— 抛出的
    // ApiError 会穿过 mutate 的回调，由 index.js 统一翻成 413。
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
    // 体积上限（审计 M5）。与文件 / 成品同口径用**字节数**，不用 String.length。
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
        // 只允许 http(s)：分享出口是 302 跳转（convert.js 的 /share/file），
        // 放行其它协议等于把分享链接变成开放重定向 / 脚本载体（审计 L2）
        if (!/^https?:\/\//i.test(u)) return '远程文件地址必须以 http:// 或 https:// 开头';
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
