import { fail, ok, nowIso, randId, maskSecret } from './util.js';
import { loadSnapshot, mutate } from './storage.js';
import { buildLinks, publicBase, convertedBackendLink } from './convert.js';
import { TARGET_LABEL } from './sce.js';

const TG_API = 'https://api.telegram.org';
const TG_TIMEOUT = 15000;

const MAX_MESSAGE_LEN = 3900;
const MAX_CHAT_ID_LEN = 64;
const MAX_CHATS = 20;

const AUTO_PUSH_DEBOUNCE_MS = 15000;

export const TG_KINDS = [
    { key: 'sub', label: '订阅', emoji: '▤' },
    { key: 'col', label: '组合', emoji: '⊕' },
    { key: 'file', label: '文件', emoji: '▦' },
    { key: 'converted', label: '成品', emoji: '★' },
];

const KIND_LABEL = Object.fromEntries(TG_KINDS.map((k) => [k.key, k.label]));
const KIND_EMOJI = Object.fromEntries(TG_KINDS.map((k) => [k.key, k.emoji]));

function defaultTelegram() {
    return {
        token: '',
        chatIds: '',
        targets: [],
        
        linkType: '',
        autoPush: false,
        lastPush: null,
    };
}

function telegramOf(snap) {
    return { ...defaultTelegram(), ...(snap?.settings?.telegram || {}) };
}

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
        
        
        tokenMask: maskSecret(c.token),
        chatIds: c.chatIds || '',
        chatCount,
        targets: Array.isArray(c.targets) ? c.targets : [],
        linkType: c.linkType || '',
        autoPush: !!c.autoPush,
        lastPush: c.lastPush || null,
    };
}

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
        
        
        if (!/^-?\d+$/.test(p) && !/^[A-Za-z][A-Za-z0-9_]+$/.test(p)) {
            throw new Error(`推送 ID 格式不合法：${p}（应为数字，或 @频道名）`);
        }
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
    }
    return out;
}

function normalizeChatIds(raw) {
    return parseChatIds(raw).join(',');
}

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

function findTarget(snap, kind, name) {
    
    
    const pools = {
        sub: snap.subs,
        col: snap.collections,
        file: snap.files,
        converted: snap.converted,
    };
    return asList(pools[kind]).find((x) => x.name === name) || null;
}

const SHARE_KINDS = new Set(['file', 'converted']);

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
            
            const item = asList(snap.converted).find((c) => c.name === name);
            const url = convertedBackendLink({ env, snap, item: item || { name }, base, code });
            if (url) return { url, created };
            
        }
        return { url: `${base}/share/${kind}/${encodeURIComponent(name)}?code=${code}`, created };
    }

    
    
    const links = await buildLinks({ url: `${base}/` }, env, snap, { kind, name, target: linkType });
    return { url: links.link, created: false };
}

function escMd(s) {
    return String(s ?? '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escCode(s) {
    return String(s ?? '').replace(/([\\`])/g, '\\$1');
}

function clamp(text) {
    const s = Array.isArray(text) ? text.join('\n') : String(text ?? '');
    if (s.length <= MAX_MESSAGE_LEN) return s;

    const tail = s.match(/`([^`\n]*)`\s*$/);
    if (tail && tail[0].length + 40 < MAX_MESSAGE_LEN) {
        const keep = MAX_MESSAGE_LEN - tail[0].length - 20;
        
        const head = s.slice(0, keep).replace(/\\+$/, (bs) => (bs.length % 2 ? bs.slice(0, -1) : bs));
        return `${head}\n…（已截断）\n${tail[0]}`;
    }
    
    return `${s.slice(0, MAX_MESSAGE_LEN - 20)}\n…（已截断）`;
}

function renderOne(item) {
    const lines = [`*${escMd(item.title)}*`];
    if (item.meta) lines.push('', `_${escMd(item.meta)}_`);
    lines.push('', `\`${escCode(item.url)}\``);
    return lines.join('\n');
}

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
        
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false,
    });
}

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
        
        return fail(`全部 ${failures.length} 条推送失败：\n${failures.map((f) => `· ${f}`).join('\n')}`, 502);
    }
    return ok({ sent, targets: items.length, chats: chatIds.length, messages: messages.length, failures, lastPush });
}

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

const lastAutoPush = new Map();

export function isTargetMutation(path, method) {
    if (method === 'POST' && (path === '/api/subs' || path === '/api/collections')) return true;
    if (method === 'POST' && path === '/api/converted') return true;
    if (method === 'POST' && /^\/api\/sub\/[^/]+\/rename$/.test(path)) return true;
    if (['PATCH', 'DELETE'].includes(method) && /^\/api\/(sub|collection)\/[^/]+$/.test(path)) {
        return true;
    }
    return false;
}

async function mutationTarget(path, method, bodyText) {
    const m1 = path.match(/^\/api\/(sub|collection)\/([^/]+)(\/rename)?$/);
    if (m1) {
        const kind = m1[1] === 'sub' ? 'sub' : 'col';
        
        if (m1[3] === 'rename') {
            const body = safeJson(bodyText);
            const newName = String(body?.name || '').trim();
            return newName ? { kind, name: newName } : null;
        }
        
        if (method === 'DELETE') return null;
        return { kind, name: decodeURIComponent(m1[2]) };
    }
    if (method === 'POST' && (path === '/api/subs' || path === '/api/collections')) {
        const body = safeJson(bodyText);
        const name = String(body?.name || '').trim();
        if (!name) return null;
        return { kind: path === '/api/subs' ? 'sub' : 'col', name };
    }
    
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

export async function autoPushAfterMutation(request, env, bodyText, { path, method }) {
    try {
        const snap = await loadSnapshot(env);
        const cfg = telegramOf(snap);
        if (!cfg.autoPush || !cfg.token || !cfg.chatIds) return;
        const t = await mutationTarget(path, method, bodyText);
        if (!t) return;
        
        if (!asList(cfg.targets).some((x) => x.kind === t.kind && x.name === t.name)) return;

        const key = `${t.kind}:${t.name}`;
        const now = Date.now();
        if (now - (lastAutoPush.get(key) || 0) < AUTO_PUSH_DEBOUNCE_MS) return;
        lastAutoPush.set(key, now);

        await push(request, env, { targets: [t] });
    } catch {
        
    }
}
