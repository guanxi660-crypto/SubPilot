// 通用工具：响应构造、Base64、随机串、常量时间比较。
// 刻意不依赖 Node 内置模块 —— Workers 下最省事，本地 wrangler dev 也一致。

const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8' };

export function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders },
    });
}

/** 统一成功响应：{ status:'success', data } */
export function ok(data = null, status = 200) {
    return json({ status: 'success', data }, status);
}

/** 统一失败响应：{ status:'failed', message, details? } */
export function fail(message, status = 400, details = '') {
    return json({ status: 'failed', message, ...(details ? { details } : {}) }, status);
}

export function text(body, status = 200, contentType = 'text/plain;charset=UTF-8', extraHeaders = {}) {
    return new Response(body, { status, headers: { 'Content-Type': contentType, ...extraHeaders } });
}

// ---- Base64 ----

/** 宽容解码：自动补 padding、兼容 URL-safe 字符、容忍空白与换行 */
export function b64decode(input) {
    if (input == null) return '';
    let s = String(input).replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!s) return '';
    const pad = s.length % 4;
    if (pad === 1) return ''; // 非法长度，直接放弃
    if (pad) s += '='.repeat(4 - pad);
    try {
        // atob 只接受 latin1；再用 UTF-8 解码还原中文
        const bin = atob(s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return '';
    }
}

/** UTF-8 安全的 Base64 编码（标准字符表，不带换行） */
export function b64encode(str) {
    const bytes = new TextEncoder().encode(String(str ?? ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

/** URL-safe Base64（用于拼链接参数） */
export function b64urlEncode(str) {
    return b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 字节数组 → URL-safe Base64。
 * 注意别用 b64urlEncode(String.fromCharCode(...bytes))：那个函数按 UTF-8 编码，
 * 字节 ≥ 0x80 会被扩成两个字节，结果整个是错的。
 */
export function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 判断一段文本是否「像」Base64（用于订阅内容格式嗅探） */
export function looksLikeBase64(s) {
    const t = String(s || '').replace(/[\s\r\n]+/g, '');
    if (t.length < 8) return false;
    return /^[A-Za-z0-9+/\-_]+={0,2}$/.test(t);
}

// ---- 随机 / 时间 ----

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** CSPRNG 随机串，默认 25 位 base36（≈129bit），用于分享码 */
export function randId(len = 25) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

export function nowIso() {
    return new Date().toISOString();
}

// ---- 比较 / 校验 ----

/**
 * 常量时间字符串比较。
 * 用途：令牌校验。避免 `===` 的短路比较在理论上泄漏前缀长度信息。
 */
export function safeEqual(a, b) {
    const x = String(a ?? '');
    const y = String(b ?? '');
    // 长度也要抹平：先各自哈希到固定长度再逐字节比
    const hx = fnv1a(x);
    const hy = fnv1a(y);
    let diff = x.length ^ y.length;
    for (let i = 0; i < hx.length; i++) diff |= hx.charCodeAt(i) ^ hy.charCodeAt(i);
    return diff === 0 && x.length === y.length;
}

function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * 凭据掩码 —— 只用于**回显给用户看**，绝不用于存储或比较。
 *
 * 全站只留这一个实现。此前 api.js（4+4）和 telegram.js（6+4）各写了一套，
 * 结果同一个 Bot Token 在「设置」页和「同步」页显示出的掩码不一样，
 * 看起来像被改过，用户会以为配置串了。
 */
export function maskSecret(v, { head = 4, tail = 4 } = {}) {
    const s = String(v || '');
    if (!s) return '';
    // 太短就整体打码：head+tail 的掩码在等长以下的串上等于漏出去一半原文
    if (s.length <= head + tail) return '****';
    return `${s.slice(0, head)}****${s.slice(-tail)}`;
}

export function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 名称里明确不允许的字符：会破坏 URL 路径语义、或在不同文件系统上非法。
// 注意**不包含空格** —— 名字会被 encodeURIComponent 编进路径，空格完全安全，
// 而机场订阅名带空格非常常见（"演示机场 A"、"XX 机场 (专线)"），
// 一刀切禁空白会把正常名字挡在门外。
const NAME_BAD_CHARS = /[/\\?#%*"<>|]/;

/** 名称校验：非空、不含路径/文件系统危险字符（名称即 URL 路径段） */
export function validateName(name, { allowSlash = false, maxLen = 0 } = {}) {
    const n = String(name ?? '').trim();
    if (!n) return '名称不能为空';
    // 控制字符一律拒绝（含换行、制表、NUL）
    if (/[\u0000-\u001f\u007f]/.test(n)) return '名称不能包含控制字符';
    const probe = allowSlash ? n.replace(/\//g, '') : n;
    if (NAME_BAD_CHARS.test(probe)) {
        return allowSlash ? '名称不能包含 \\ ? # % * " < > |' : '名称不能包含 / \\ ? # % * " < > |';
    }
    if (n.startsWith('.') || n.includes('..')) return '名称不能以点开头或包含 ..';
    if (maxLen && n.length > maxLen) return `名称不能超过 ${maxLen} 个字符`;
    return '';
}

/** 把任意值收敛成字符串数组（用于 url 多行 / 多值输入） */
export function toStringArray(v) {
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (typeof v === 'string') {
        return v
            .split(/[\r\n|]+/)
            .map((x) => x.trim())
            .filter(Boolean);
    }
    return [];
}

/** 只保留白名单字段，避免外部 JSON 塞入任意键 */
export function pick(obj, keys) {
    const out = {};
    if (!isPlainObject(obj)) return out;
    for (const k of keys) if (k in obj) out[k] = obj[k];
    return out;
}
