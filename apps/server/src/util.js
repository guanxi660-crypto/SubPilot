const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8' };

export function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders },
    });
}

export function ok(data = null, status = 200) {
    return json({ status: 'success', data }, status);
}

export function fail(message, status = 400, details = '') {
    return json({ status: 'failed', message, ...(details ? { details } : {}) }, status);
}

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

export function b64decode(input) {
    if (input == null) return '';
    let s = String(input).replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!s) return '';
    const pad = s.length % 4;
    if (pad === 1) return ''; 
    if (pad) s += '='.repeat(4 - pad);
    try {
        
        const bin = atob(s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return '';
    }
}

export function b64encode(str) {
    const bytes = new TextEncoder().encode(String(str ?? ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

export function b64urlEncode(str) {
    return b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function looksLikeBase64(s) {
    const t = String(s || '').replace(/[\s\r\n]+/g, '');
    if (t.length < 8) return false;
    return /^[A-Za-z0-9+/\-_]+={0,2}$/.test(t);
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

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

export function maskSecret(v, { head = 4, tail = 4 } = {}) {
    const s = String(v || '');
    if (!s) return '';
    
    if (s.length <= head + tail) return '****';
    return `${s.slice(0, head)}****${s.slice(-tail)}`;
}

export function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

const NAME_BAD_CHARS = /[/\\?#%*"<>|]/;

export function validateName(name, { allowSlash = false, maxLen = 0 } = {}) {
    const n = String(name ?? '').trim();
    if (!n) return '名称不能为空';
    
    if (/[\u0000-\u001f\u007f]/.test(n)) return '名称不能包含控制字符';
    const probe = allowSlash ? n.replace(/\//g, '') : n;
    if (NAME_BAD_CHARS.test(probe)) {
        return allowSlash ? '名称不能包含 \\ ? # % * " < > |' : '名称不能包含 / \\ ? # % * " < > |';
    }
    if (n.startsWith('.') || n.includes('..')) return '名称不能以点开头或包含 ..';
    if (maxLen && n.length > maxLen) return `名称不能超过 ${maxLen} 个字符`;
    return '';
}

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

export function pick(obj, keys) {
    const out = {};
    if (!isPlainObject(obj)) return out;
    for (const k of keys) if (k in obj) out[k] = obj[k];
    return out;
}
