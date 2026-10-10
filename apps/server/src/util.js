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

/**
 * 带 HTTP 状态码的业务异常。
 *
 * 为什么需要它：有些校验只能发生在**深层工具函数**里（比如 normalizeSub 要挡住
 * 超限的订阅正文），而这类函数此前只能「返回错误串」或「静默放行」——
 * 返回串没法穿过 mutate 的回调，静默放行又等于没挡。于是第二道兜底要么不存在，
 * 要么退化成一个裸 Error 被入口统一翻成 500（审计 M5 里提到的「500 而不是明确
 * 拒绝」）。抛这个异常就能一路穿过 mutate，由 index.js 的 catch 翻成对应状态码。
 *
 * `expose: true` 是给入口看的开关 —— 只有明确标记过的异常才把 message 回给客户端，
 * 其余异常一律折叠成「服务器内部错误」，避免把堆栈 / 内部路径泄漏出去。
 */
export class ApiError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.expose = true;
    }
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
 *
 * ⚠️ 必须比**原文**，绝不能比原文的短哈希。此前的实现是「各自算 32 位 FNV-1a
 * 再逐字符比」，判定条件变成「长度相同 **且** 32 位哈希相同」—— 32 位摘要空间
 * 可离线枚举（生日碰撞约 2^16 次尝试），等长碰撞串会被判为合法令牌，构成实质
 * 鉴权绕过（审计 S1）。
 *
 * 现在按较长的长度固定轮数循环，越界侧取 0，长度差也并进 diff：
 * 无论输入多长，循环次数只与长度有关，比较耗时与「第几位开始不同」无关。
 */
export function safeEqual(a, b) {
    const x = String(a ?? '');
    const y = String(b ?? '');
    const n = Math.max(x.length, y.length);
    let diff = x.length ^ y.length;
    for (let i = 0; i < n; i++) {
        diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    }
    return diff === 0;
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
