// TG 推送：把订阅 / 组合 / 文件的链接推到 Telegram 聊天。
//
// 路由（都在 /api/ 下，因此受管理令牌保护，见 index.js 的 PROTECTED_PREFIXES）：
//   GET  /api/telegram/config   读配置（token 只回掩码）
//   POST /api/telegram/config   存配置（token 留空 = 不修改）
//   POST /api/telegram/test     测试推送（发一条固定文本到第一个 chat_id）
//   POST /api/telegram/push     正式推送
//
// 设计要点：
// 1. bot token 存在快照的 settings.telegram 里，**只回 tokenSet / tokenMask**。
//    这一点必须在 api.js 的 publicSettings 里也同步做一遍，否则 /api/settings
//    会把明文吐出来 —— 那是本站唯一的下发口，漏了等于把机器人交出去。
// 2. 推送链接一律复用本站既有的**只读**分发通道，绝不含管理令牌：
//      · 订阅 / 组合 → /download/…?ft=<HMAC 派生密钥>（无状态，不吃分享码配额）
//      · 文件       → /share/file/…?code=<分享码>（文件没有派生密钥通道，复用已有的）
//    这两类地址会长期留在聊天记录里，塞管理令牌等于把管理员凭据发出去。
// 3. 推送正文从 KV 现读，不接受前端传入 —— 否则这个接口就成了任意内容投递器。
// 4. chat_id 允许多值，逐个校验格式；非法项**报错而不是静默丢弃**，
//    静默丢弃会让人以为推成功了。

import { fail, ok, nowIso, randId, maskSecret } from './util.js';
import { loadSnapshot, mutate } from './storage.js';
import { buildLinks, publicBase, convertedBackendLink } from './convert.js';
import { TARGET_LABEL } from './sce.js';

const TG_API = 'https://api.telegram.org';
const TG_TIMEOUT = 15000;
// TG 单条消息上限 4096，留足余量
const MAX_MESSAGE_LEN = 3900;
const MAX_CHAT_ID_LEN = 64;
const MAX_CHATS = 20;
// 同一项 15s 内的连续变动只推一次（编辑保存常常连点）
const AUTO_PUSH_DEBOUNCE_MS = 15000;

/**
 * 可推送的资源类型。
 *
 * sub / col 有 HMAC 派生的只读分发通道（/download/…?ft=），不吃分享码配额；
 * file / converted 没有派生通道，走分享码（/share/<type>/<name>?code=）。
 * 两类在 targetLink 里分岔。
 */
export const TG_KINDS = [
    { key: 'sub', label: '订阅', emoji: '▤' },
    { key: 'col', label: '组合', emoji: '⊕' },
    { key: 'file', label: '文件', emoji: '▦' },
    { key: 'converted', label: '成品', emoji: '★' },
];

const KIND_LABEL = Object.fromEntries(TG_KINDS.map((k) => [k.key, k.label]));
const KIND_EMOJI = Object.fromEntries(TG_KINDS.map((k) => [k.key, k.emoji]));
// 注意：TARGET_LABEL 是**含已下线格式**的全量映射（见 sce.js），
// 用它做 linkType 校验是为了让老配置仍能保存 —— 不要换成 SCE_TARGETS。

// ---------------------------------------------------------------- 配置读写

function defaultTelegram() {
    return {
        token: '',
        chatIds: '',
        targets: [],
        // 推送链接的客户端格式。'' = 不指定 target（由 SCE 决定）
        linkType: '',
        autoPush: false,
        lastPush: null,
    };
}

function telegramOf(snap) {
    return { ...defaultTelegram(), ...(snap?.settings?.telegram || {}) };
}

/** 给前端的配置：**不含明文 token** */
export function publicTelegram(cfg) {
    const c = { ...defaultTelegram(), ...(cfg || {}) };
    let chatCount = 0;
    try {
        chatCount = c.chatIds ? parseChatIds(c.chatIds).length : 0;
    } catch {
        chatCount = 0;
    }
    return {
        tokenSet: !!c.token,
        // 掩码走 util.js 的统一实现（此前这里另有一套 6+4 的，导致同一个 token
        // 在「设置」页和「同步」页显示的掩码不一样）
        tokenMask: maskSecret(c.token),
        chatIds: c.chatIds || '',
        chatCount,
        targets: Array.isArray(c.targets) ? c.targets : [],
        linkType: c.linkType || '',
        autoPush: !!c.autoPush,
        lastPush: c.lastPush || null,
    };
}

// ---------------------------------------------------------------- 参数解析

/**
 * 解析 chat_id 串 → 去重数组。
 * 支持中英文逗号 / 空格 / 换行分隔，可带 @ 前缀。
 */
export function parseChatIds(raw) {
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
    const parts = text
        .split(/[,，\s]+/)
        .map((s) => s.trim().replace(/^@/, ''))
        .filter(Boolean);
    if (!parts.length) throw new Error('请填写至少一个推送 ID（chat_id）');
    if (parts.length > MAX_CHATS) {
        throw new Error(`推送 ID 最多 ${MAX_CHATS} 个，当前 ${parts.length} 个`);
    }
    const out = [];
    const seen = new Set();
    for (const p of parts) {
        if (p.length > MAX_CHAT_ID_LEN) throw new Error(`推送 ID 过长：${p.slice(0, 20)}…`);
        // 数字 ID（私聊 / 群 / -100 开头的频道）或 @频道名。
        // 真正的存在性交给 TG 校验 —— 它返回的 "chat not found" 比前端正则更有信息量。
        if (!/^-?\d+$/.test(p) && !/^[A-Za-z][A-Za-z0-9_]+$/.test(p)) {
            throw new Error(`推送 ID 格式不合法：${p}（应为数字，或 @频道名）`);
        }
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
    }
    return out;
}

/** 归一化成前端可回填的逗号串 */
function normalizeChatIds(raw) {
    return parseChatIds(raw).join(',');
}

/** 校验目标数组：元素形如 { kind, name } */
function parseTargets(raw, { allowEmpty = false } = {}) {
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) {
        if (allowEmpty) return [];
        throw new Error('请至少选择一个要推送的订阅、组合或文件');
    }
    const out = [];
    const seen = new Set();
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const kind = String(item.kind || '');
        const name = String(item.name || '').trim();
        if (!KIND_LABEL[kind]) throw new Error(`不支持的推送类型：${kind}`);
        if (!name) throw new Error('推送目标缺少名称');
        const key = `${kind}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, name });
    }
    if (!out.length && !allowEmpty) throw new Error('请至少选择一个要推送的订阅、组合或文件');
    return out;
}

function asList(v) {
    return Array.isArray(v) ? v : [];
}

/** 从快照里按类型取资源 */
function findTarget(snap, kind, name) {
    // 用映射而不是嵌套三元：加一种可推送类型时只改这一处，
    // 忘了改的后果是「推送时找不到目标」，报错信息还指不到根因。
    const pools = {
        sub: snap.subs,
        col: snap.collections,
        file: snap.files,
        converted: snap.converted,
    };
    return asList(pools[kind]).find((x) => x.name === name) || null;
}

/** 走分享码通道的类型（没有 HMAC 派生密钥，只能靠一次性分享码分发） */
const SHARE_KINDS = new Set(['file', 'converted']);

// ---------------------------------------------------------------- 链接生成

/**
 * 生成某个目标的只读分发链接。
 *
 * 订阅 / 组合：走 buildLinks → /download/…?ft=派生密钥，无状态、不吃分享码配额。
 * 文件：没有派生密钥通道，复用 /share/file/…?code=。优先复用已有的、未过期的
 *       分享码，没有才新建一个永久有效的 —— 否则每推一次就多一条分享码，
 *       900 条上限会被慢慢吃光。
 * 成品：推的是**成品链接**（转换后端格式的快照链，见 convert.js 的
 *       convertedBackendLink）—— 与成品卡片上「⧉ 分享链接」复制出来的那条
 *       逐字一致。它同样以快照的分享码为基底，所以这里仍要先拿到 / 建好分享码。
 *
 * ⚠️ 推送链接一律**原样**，绝不在 URL 上附加任何来源标记 —— 用户明确要求
 * 「原链接是什么推送什么」。统计侧要跳过 TG 抓预览的那一跳，只能认请求特征
 * （见 convert.js 的 isTgCrawler）。
 *
 * @param {string} base 对外基地址（已剥掉尾部斜杠）
 * @returns {Promise<{url: string, created: boolean}>}
 */
async function targetLink(env, snap, { kind, name, linkType, base }) {
    if (SHARE_KINDS.has(kind)) {
        const alive = asList(snap.shares).find(
            (s) =>
                s.type === kind &&
                s.name === name &&
                (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now()),
        );
        let code = alive?.code || '';
        const created = !code;
        if (created) {
            code = randId(25);
            await mutate(env, (s) => {
                s.shares.push({
                    code,
                    type: kind,
                    name,
                    createdAt: nowIso(),
                    expiresAt: null,
                    uses: 0,
                });
            });
        }
        if (kind === 'converted') {
            // snap 是 mutate 之前的那份，新码还没写进去 —— 显式把 code 传下去
            const item = asList(snap.converted).find((c) => c.name === name);
            const url = convertedBackendLink({ env, snap, item: item || { name }, base, code });
            if (url) return { url, created };
            // 拿不到后端地址时退回快照直链（resolveBackend 有兜底，正常走不到这里）
        }
        return { url: `${base}/share/${kind}/${encodeURIComponent(name)}?code=${code}`, created };
    }

    // buildLinks 只从 request 里取 base（settings.publicBaseUrl 优先，否则 request.url），
    // 这里已经算好 base 了，用一个最小 shim 传进去即可，不必复制一份 base 推导逻辑。
    const links = await buildLinks({ url: `${base}/` }, env, snap, { kind, name, target: linkType });
    return { url: links.link, created: false };
}

// ---------------------------------------------------------------- 消息渲染

/** MarkdownV2 转义 */
function escMd(s) {
    return String(s ?? '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** 内联代码里只需转义反斜杠与反引号；URL 里的 ? & = . 必须原样保留，否则链接失效 */
function escCode(s) {
    return String(s ?? '').replace(/([\\`])/g, '\\$1');
}

/**
 * 超长消息的兜底截断。
 *
 * 正常路径上 renderOne / renderBatch 已经保证不超长，这里是最后一道保险。
 * 关键：**优先保住末尾的 URL 块** —— 消息的全部价值就在那个链接上，
 * 从中间切一刀会让它变成一个打不开的地址，而用户还以为推成功了。
 *
 * 为什么截断头部是安全的：消息结构固定是「标题 / meta / `URL`」，URL 永远在最后，
 * 而标题与 meta 里的特殊字符已被 escMd 转义成 \x，不会残留裸露的 ` 造成
 * 代码块不闭合（那会让 TG 直接以 400 拒绝整条消息）。
 */
function clamp(text) {
    const s = Array.isArray(text) ? text.join('\n') : String(text ?? '');
    if (s.length <= MAX_MESSAGE_LEN) return s;

    const tail = s.match(/`([^`\n]*)`\s*$/);
    if (tail && tail[0].length + 40 < MAX_MESSAGE_LEN) {
        const keep = MAX_MESSAGE_LEN - tail[0].length - 20;
        // 去掉末尾可能被切一半的转义反斜杠：留下孤立的 \ 会把后面的「…」也转义掉
        const head = s.slice(0, keep).replace(/\\+$/, (bs) => (bs.length % 2 ? bs.slice(0, -1) : bs));
        return `${head}\n…（已截断）\n${tail[0]}`;
    }
    // 连 URL 本身都超过上限（极端情况）：TG 也发不出去，只能如实截断
    return `${s.slice(0, MAX_MESSAGE_LEN - 20)}\n…（已截断）`;
}

/** 单条目标的消息体 */
function renderOne(item) {
    const lines = [`*${escMd(item.title)}*`];
    if (item.meta) lines.push('', `_${escMd(item.meta)}_`);
    lines.push('', `\`${escCode(item.url)}\``);
    return lines.join('\n');
}

/**
 * 多目标合并成一条消息，超长自动分片。
 * 分片时**整块挪到下一片**，绝不从中间截断 —— 截断后的 URL 不可用。
 */
function renderBatch(items) {
    const head = [`*📦 SubPilot 推送*（共 ${items.length} 项）`];
    const blocks = items.map((it) => {
        const block = ['', `*${escMd(it.title)}*`];
        if (it.meta) block.push('', `_${escMd(it.meta)}_`);
        block.push('', `\`${escCode(it.url)}\``);
        return block;
    });

    const chunks = [];
    let cur = [...head];
    let curLen = cur.join('\n').length + 1;
    for (const block of blocks) {
        const blockLen = block.join('\n').length + 1;
        if (curLen + blockLen > MAX_MESSAGE_LEN && cur.length > head.length) {
            chunks.push(cur.join('\n'));
            cur = [];
            curLen = 0;
        }
        cur.push(...block);
        curLen += blockLen;
    }
    if (cur.length) chunks.push(cur.join('\n'));
    return chunks.length ? chunks : [head.join('\n')];
}

// ---------------------------------------------------------------- Telegram API

async function tgFetch(botToken, method, payload) {
    let resp;
    try {
        resp = await fetch(`${TG_API}/bot${botToken}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(TG_TIMEOUT),
        });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error(
                `连接 Telegram 超时（${Math.round(TG_TIMEOUT / 1000)} 秒）。` +
                    '若本机走代理，请确认代理放行了 api.telegram.org。',
            );
        }
        throw e;
    }
    const raw = await resp.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch {
        /* TG 偶尔返回非 JSON（网关页等） */
    }
    if (!resp.ok || !json?.ok) {
        throw new Error(`TG 返回错误：${json?.description || `HTTP ${resp.status}`}`);
    }
    return json.result;
}

function tgSend(token, chatId, text) {
    return tgFetch(token, 'sendMessage', {
        chat_id: chatId,
        text: clamp(text),
        // 渲染时按 MarkdownV2 转义过；不声明 parse_mode 会让转义反斜杠原样显示
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false,
    });
}

// ---------------------------------------------------------------- 路由

export async function handleTelegram(request, env, ctx, { path, query, method }) {
    const seg = path.replace(/^\/api\/telegram\/?/, '').split('/').filter(Boolean);
    const action = seg[0] || '';

    if (action === 'config' && method === 'GET') {
        const snap = await loadSnapshot(env);
        return ok(publicTelegram(telegramOf(snap)));
    }

    if (action === 'config' && method === 'POST') {
        const body = await readJson(request);
        if (body === null) return fail('请求体不是合法 JSON', 400);
        let saved = null;
        try {
            const { snap } = await mutate(env, (s) => {
                const cfg = telegramOf(s);
                // token：空串 = 不修改（与 WebDAV 密码、Gist Token 一致）
                if (typeof body.token === 'string' && body.token.trim()) {
                    cfg.token = body.token.trim();
                }
                if (body.chatIds !== undefined) cfg.chatIds = normalizeChatIds(body.chatIds);
                if (body.targets !== undefined) cfg.targets = parseTargets(body.targets, { allowEmpty: true });
                if (body.linkType !== undefined) {
                    const lt = String(body.linkType || '');
                    if (lt && !TARGET_LABEL[lt]) throw new Error(`不支持的链接类型：${lt}`);
                    cfg.linkType = lt;
                }
                if (body.autoPush !== undefined) cfg.autoPush = !!body.autoPush;
                s.settings.telegram = cfg;
                saved = publicTelegram(cfg);
                return null;
            });
            return ok(saved ?? publicTelegram(telegramOf(snap)));
        } catch (e) {
            return fail(e?.message || '保存失败', 400);
        }
    }

    if (action === 'test' && method === 'POST') {
        const body = await readJson(request);
        if (body === null) return fail('请求体不是合法 JSON', 400);
        const snap = await loadSnapshot(env);
        const cfg = telegramOf(snap);
        // 允许「先填再测」：请求体带了就用请求体的，否则用已存的
        const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : cfg.token;
        if (!token) return fail('请先填写 TG Bot Token', 400);
        let chatIds;
        try {
            chatIds = parseChatIds(body.chatIds ?? cfg.chatIds ?? '');
        } catch (e) {
            return fail(e.message, 400);
        }
        const chatId = chatIds[0];
        const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const text = [
            '✅ *SubPilot 连通性测试*',
            '',
            `推送 ID ${escMd(chatId)} 可用。`,
            `时间：${escMd(stamp)}`,
        ].join('\n');
        try {
            await tgSend(token, chatId, text);
            return ok({ ok: true, chatId });
        } catch (e) {
            return fail(e.message, 502);
        }
    }

    if (action === 'push' && method === 'POST') {
        const body = await readJson(request);
        if (body === null) return fail('请求体不是合法 JSON', 400);
        return push(request, env, body);
    }

    return fail(`未知接口：${method} ${path}`, 404);
}

/**
 * 正式推送。
 * body 可带 targets / token / chatIds 覆盖已存配置（卡片上的「立即推送此订阅」就是这么用的）。
 */
async function push(request, env, body) {
    const snap = await loadSnapshot(env);
    const cfg = telegramOf(snap);
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : cfg.token;
    if (!token) return fail('请先填写 TG Bot Token', 400);

    let chatIds;
    try {
        chatIds = parseChatIds(body.chatIds ?? cfg.chatIds ?? '');
    } catch (e) {
        return fail(e.message, 400);
    }

    let targets;
    try {
        targets = parseTargets(body.targets ?? cfg.targets);
    } catch (e) {
        return fail(e.message, 400);
    }

    const linkType = body.linkType !== undefined ? String(body.linkType || '') : cfg.linkType || '';
    const base = baseFor(request, snap);

    // 先把目标全查一遍，缺失的一次报出来 —— 边推边发现缺失很烦
    const missing = [];
    const items = [];
    for (const t of targets) {
        const found = findTarget(snap, t.kind, t.name);
        if (!found) {
            missing.push(`${KIND_LABEL[t.kind]}「${t.name}」`);
            continue;
        }
        const { url } = await targetLink(env, snap, { kind: t.kind, name: t.name, linkType, base });
        if (!url || url.startsWith('/')) {
            missing.push(`${KIND_LABEL[t.kind]}「${t.name}」（拿不到对外地址）`);
            continue;
        }
        items.push({
            title: `${KIND_EMOJI[t.kind]} ${found.displayName || found.name}`,
            url,
            // 文件和成品的链接与 target 参数无关，写「格式」会误导；
            // 成品本身就是某一种格式的产物，把它的 target 标出来反而有用。
            meta: SHARE_KINDS.has(t.kind)
                ? t.kind === 'converted'
                    ? `成品 · ${TARGET_LABEL[found.target] || found.target || '通用'}`
                    : '文件'
                : linkType
                  ? `格式：${TARGET_LABEL[linkType] || linkType}`
                  : '',
        });
    }
    if (missing.length) return fail(`以下项目找不到或没有链接：${missing.join('、')}`, 404);
    if (!items.length) return fail('没有可推送的内容', 400);

    const messages = items.length === 1 ? [renderOne(items[0])] : renderBatch(items);

    // 串行发送：TG 对同一 bot 有频率限制，并发容易撞 429
    let sent = 0;
    const failures = [];
    for (const chatId of chatIds) {
        for (const msg of messages) {
            try {
                await tgSend(token, chatId, msg);
                sent += 1;
            } catch (e) {
                failures.push(`${chatId}：${e.message}`);
            }
        }
    }

    const lastPush = {
        at: nowIso(),
        ok: sent > 0,
        sent,
        chats: chatIds.length,
        targets: items.length,
        error: sent ? '' : failures.join('；'),
    };
    await mutate(env, (s) => {
        const c = telegramOf(s);
        c.lastPush = lastPush;
        s.settings.telegram = c;
    });

    if (!sent) {
        // 全失败时把**所有**原因都带出去 —— 多 chat_id 时只报第一条，用户无从判断是哪个 ID 有问题
        return fail(`全部 ${failures.length} 条推送失败：\n${failures.map((f) => `· ${f}`).join('\n')}`, 502);
    }
    return ok({ sent, targets: items.length, chats: chatIds.length, messages: messages.length, failures, lastPush });
}

/** 对外基地址。与 convert.js 的 publicBase 同源，不另造一套规则。 */
function baseFor(request, snap) {
    try {
        return publicBase(request, snap?.settings);
    } catch {
        return '';
    }
}

async function readJson(request) {
    try {
        const t = await request.text();
        if (!t) return {};
        const v = JSON.parse(t);
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- 变动即时推送

const lastAutoPush = new Map();

/**
 * 路径是否属于「订阅 / 组合 / 成品 的增删改」。
 *
 * 成品也算：保存成品（POST /api/converted 是 upsert）就是一次「内容变了」，
 * 勾了「即时推送」的用户自然期望它自动推一次。
 * 改名走各自的 PATCH，这里不额外处理 —— 成品没有单独的改名接口。
 */
export function isTargetMutation(path, method) {
    if (method === 'POST' && (path === '/api/subs' || path === '/api/collections')) return true;
    if (method === 'POST' && path === '/api/converted') return true;
    if (method === 'POST' && /^\/api\/sub\/[^/]+\/rename$/.test(path)) return true;
    if (['PATCH', 'DELETE'].includes(method) && /^\/api\/(sub|collection)\/[^/]+$/.test(path)) {
        return true;
    }
    return false;
}

/** 从路径 / 请求体里取出这次变动涉及的资源 */
async function mutationTarget(path, method, bodyText) {
    const m1 = path.match(/^\/api\/(sub|collection)\/([^/]+)(\/rename)?$/);
    if (m1) {
        const kind = m1[1] === 'sub' ? 'sub' : 'col';
        // 改名后要推的是**新名字**，旧名字已经查不到了
        if (m1[3] === 'rename') {
            const body = safeJson(bodyText);
            const newName = String(body?.name || '').trim();
            return newName ? { kind, name: newName } : null;
        }
        // 删除：资源已不存在，推了也没内容
        if (method === 'DELETE') return null;
        return { kind, name: decodeURIComponent(m1[2]) };
    }
    if (method === 'POST' && (path === '/api/subs' || path === '/api/collections')) {
        const body = safeJson(bodyText);
        const name = String(body?.name || '').trim();
        if (!name) return null;
        return { kind: path === '/api/subs' ? 'sub' : 'col', name };
    }
    // 保存成品：POST /api/converted 是 upsert，同名视为覆盖更新
    if (method === 'POST' && path === '/api/converted') {
        const body = safeJson(bodyText);
        const name = String(body?.name || '').trim();
        return name ? { kind: 'converted', name } : null;
    }
    return null;
}

function safeJson(text) {
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

/**
 * 变动后按需即时推送。由 index.js 在 /api/ 响应成功后调用。
 *
 * 这里是「尽力而为」：任何失败都只写进 lastPush.error，绝不抛给调用方 ——
 * 一次推送失败不该让「保存订阅」这个动作看起来失败了。
 */
export async function autoPushAfterMutation(request, env, bodyText, { path, method }) {
    try {
        const snap = await loadSnapshot(env);
        const cfg = telegramOf(snap);
        if (!cfg.autoPush || !cfg.token || !cfg.chatIds) return;
        const t = await mutationTarget(path, method, bodyText);
        if (!t) return;
        // 只推用户勾选过的项，避免「开了开关就被全量刷屏」
        if (!asList(cfg.targets).some((x) => x.kind === t.kind && x.name === t.name)) return;

        const key = `${t.kind}:${t.name}`;
        const now = Date.now();
        if (now - (lastAutoPush.get(key) || 0) < AUTO_PUSH_DEBOUNCE_MS) return;
        lastAutoPush.set(key, now);

        await push(request, env, { targets: [t] });
    } catch {
        /* 尽力而为 */
    }
}
