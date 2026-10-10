const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data', 
    '169.254.169.254',
    '169.254.170.2', 
    '100.100.100.200', 
    'fd00:ec2::254', 
]);

const BLOCKED_SUFFIXES = [
    '.internal',
    '.local',
    '.localhost',
    '.home.arpa',
    '.lan',
    '.intranet',
    '.corp',
];

function bareHost(host) {
    return String(host || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
}

function isFakeIp(host) {
    return /^198\.1[89]\.\d{1,3}\.\d{1,3}$/.test(bareHost(host));
}

export function isPrivateIp(host) {
    const h = bareHost(host);

    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const c = Number(m[3]);
        if ([a, b, c, Number(m[4])].some((n) => n > 255)) return false;
        if (a === 0) return true; 
        if (a === 10) return true; 
        if (a === 127) return true; 
        if (a === 169 && b === 254) return true; 
        if (a === 172 && b >= 16 && b <= 31) return true; 
        if (a === 192 && b === 168) return true; 
        if (a === 100 && b >= 64 && b <= 127) return true; 
        if (a === 192 && b === 0 && c === 0) return true; 
        if (a === 192 && b === 0 && c === 2) return true; 
        if (a === 198 && (b === 18 || b === 19)) return true; 
        if (a === 198 && b === 51 && c === 100) return true; 
        if (a === 203 && b === 0 && c === 113) return true; 
        if (a >= 224) return true; 
        return false;
    }

    if (!h.includes(':')) return false;

    if (h === '::1' || h === '::') return true;

    
    const mappedDotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isPrivateIp(mappedDotted[1]);
    const mappedHex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const n = (((parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16)) >>> 0);
        return isPrivateIp(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }

    if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; 
    if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; 
    if (/^ff[0-9a-f]{2}:/.test(h)) return true; 
    if (/^2001:db8:/.test(h)) return true; 
    if (/^64:ff9b:/.test(h)) return true; 
    return false;
}

export function checkUrlSync(raw, { allowHttp = false, allowPrivate = false, label = '地址' } = {}) {
    const s = String(raw ?? '').trim();
    if (!s) return `${label}不能为空`;

    let u;
    try {
        u = new URL(s);
    } catch {
        return `${label}格式不正确`;
    }

    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
        return allowHttp ? `${label}必须以 http:// 或 https:// 开头` : `${label}必须以 https:// 开头`;
    }
    
    if (u.username || u.password) return `${label}不能带用户名 / 密码`;

    const host = bareHost(u.hostname);
    if (!host) return `${label}缺少主机名`;
    if (BLOCKED_HOSTS.has(host)) return '不允许访问该主机（云元数据或本机别名）';
    if (BLOCKED_SUFFIXES.some((sfx) => host.endsWith(sfx))) return '不允许访问内网域名';
    if (!allowPrivate) {
        const literal = host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
        if (literal && isPrivateIp(host)) return '不允许访问内网 / 环回 / 保留地址';
    }
    return '';
}

export async function checkUrl(raw, { allowHttp = false, allowPrivate = false, resolve, label = '地址' } = {}) {
    const bad = checkUrlSync(raw, { allowHttp, allowPrivate, label });
    if (bad) return bad;
    if (allowPrivate || typeof resolve !== 'function') return '';

    let host = '';
    try {
        host = bareHost(new URL(String(raw)).hostname);
    } catch {
        return '';
    }
    
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return '';

    let ips;
    try {
        ips = await resolve(host);
    } catch {
        return `${label}的域名解析失败`;
    }
    if (!Array.isArray(ips) || !ips.length) return `${label}的域名解析不到地址`;
    for (const ip of ips) {
        
        
        if (isFakeIp(ip)) continue;
        if (isPrivateIp(ip)) return '域名解析到内网 / 环回地址，已拒绝（可能是 DNS rebinding）';
    }
    return '';
}

export function ssrfOptions(env, overrides = {}) {
    return {
        allowPrivate: String(env?.SUBPILOT_ALLOW_PRIVATE_FETCH ?? '') === '1',
        resolve: env?.RESOLVE_HOST,
        ...overrides,
    };
}

export class SsrfBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SsrfBlockedError';
        this.code = 'SSRF_BLOCKED';
        
        
        this.status = 400;
        this.expose = true;
    }
}

export async function safeFetch(rawUrl, init = {}, opts = {}) {
    const { allowHttp = false, allowPrivate = false, resolve, label = '地址', maxRedirects = MAX_REDIRECTS } = opts;

    let current = String(rawUrl ?? '').trim();
    let next = { ...init };

    for (let hop = 0; hop <= maxRedirects; hop++) {
        const bad = await checkUrl(current, { allowHttp, allowPrivate, resolve, label });
        if (bad) throw new SsrfBlockedError(bad);

        const res = await fetch(current, { ...next, redirect: 'manual' });

        
        
        if (res.status === 0 || res.type === 'opaqueredirect') {
            throw new SsrfBlockedError(`${label}发生了无法校验的重定向，已拒绝跟随`);
        }
        if (!REDIRECT_STATUS.has(res.status)) return res;

        const loc = res.headers.get('Location');
        if (!loc) return res; 

        
        try {
            await res.body?.cancel();
        } catch {
            
        }

        const method = String(next.method || 'GET').toUpperCase();
        
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
            next = { ...next, method: 'GET', body: undefined };
        }

        try {
            current = new URL(loc, current).toString();
        } catch {
            throw new SsrfBlockedError(`${label}的重定向目标不合法`);
        }
    }

    throw new SsrfBlockedError(`重定向次数超过 ${maxRedirects} 次`);
}
