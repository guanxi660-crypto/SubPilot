export const DEFAULT_SCE = 'https://subpilot.57995799.xyz';

const PASS_THROUGH = [
    'target', 'url', 'config', 'group', 'filename', 'ver', 'interval', 'strict',
    'dev_id', 'upload', 'upload_path', 'append_info',
    'include', 'exclude', 'rename',
    'emoji', 'add_emoji', 'remove_emoji', 'append_type', 'sort', 'sort_script', 'fdn',
    'udp', 'tfo', 'scv', 'tls13', 'new_name',
    'list', 'script', 'expand', 'classic', 'insert', 'prepend',
    'provider_proxy_direct', 'provider_headers', 'explain',
];

const BOOLEAN_PARAMS = new Set([
    'strict', 'upload', 'append_info', 'emoji', 'add_emoji', 'remove_emoji',
    'append_type', 'sort', 'sort_script', 'fdn', 'udp', 'tfo', 'scv', 'tls13',
    'new_name', 'list', 'script', 'expand', 'classic', 'insert', 'prepend',
    'provider_proxy_direct', 'explain',
]);

export const SCE_TARGETS = [
    { value: 'clash', label: 'Clash / Mihomo', group: 'Mihomo Provider' },
    { value: 'singbox', label: 'sing-box', group: '完整配置转换' },
    { value: 'v2ray', label: 'v2ray（外部）', group: '简单订阅输出' },
    { value: 'shadowrocket', label: 'Shadowrocket', group: '简单订阅输出' },
    { value: 'trojan', label: 'Trojan', group: '简单订阅输出' },
    { value: 'vless', label: 'VLESS', group: '简单订阅输出' },
    { value: 'hysteria2', label: 'Hysteria2', group: '简单订阅输出' },
    { value: 'ss', label: 'SS', group: '简单订阅输出' },
    { value: 'ssr', label: 'SSR', group: '简单订阅输出' },
];

const LEGACY_TARGETS = [
    
    { value: 'clashr', label: 'ClashR' },
    { value: 'surge', label: 'Surge' },
    { value: 'quanx', label: 'Quantumult X' },
    { value: 'loon', label: 'Loon' },
    { value: 'surfboard', label: 'Surfboard' },
    { value: 'stash', label: 'Stash' },
    { value: 'quan', label: 'Quantumult' },
    { value: 'mellow', label: 'Mellow' },
    { value: 'v2rayn', label: 'v2rayN' },
    { value: 'v2rayng', label: 'v2rayNG' },
    { value: 'ssd', label: 'SSD' },
    { value: 'sssub', label: 'SSSub' },
    
    
    
    { value: 'mixed', label: 'Mixed' },
];

export const TARGET_LABEL = Object.fromEntries(
    [...SCE_TARGETS, ...LEGACY_TARGETS].map((t) => [t.value, t.label]),
);

export function resolveBackend(env, settings) {
    const s = String(settings?.subBackend || env?.SUB_BACKEND || '').trim();
    const base = s || DEFAULT_SCE;
    return base.replace(/\/+$/, '');
}

function normalizeBool(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    const s = String(v).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return 'true';
    if (['false', '0', 'no', 'off'].includes(s)) return 'false';
    return '';
}

export function buildSceQuery(params) {
    const qs = new URLSearchParams();
    for (const key of PASS_THROUGH) {
        const v = params[key];
        if (v === undefined || v === null || v === '') continue;
        if (BOOLEAN_PARAMS.has(key)) {
            const b = normalizeBool(v);
            if (b) qs.set(key, b);
            continue;
        }
        qs.set(key, String(v));
    }
    return qs.toString();
}

export function buildSceUrl(base, params) {
    return `${base.replace(/\/+$/, '')}/sub?${buildSceQuery(params)}`;
}

export async function callSce(base, params, { timeoutMs = 20000, extraHeaders = {}, method = 'GET' } = {}) {
    const url = buildSceUrl(base, params);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                
                'User-Agent': 'clash-verge/v2.0 SubPilot/0.1',
                Accept: '*/*',
                ...extraHeaders,
            },
            signal: ctrl.signal,
            redirect: 'follow',
        });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

export async function probeBackend(base, { timeoutMs = 8000 } = {}) {
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) return { online: false, version: '', error: '未配置转换后端' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${root}/version`, {
            headers: { Accept: 'text/html,application/json,*/*' },
            signal: ctrl.signal,
        });
        const body = await res.text();
        if (!res.ok) {
            return { online: false, version: '', error: `后端返回 HTTP ${res.status}` };
        }
        let version = '';
        
        try {
            const j = JSON.parse(body);
            version = j.version || j.release || j.tag || '';
        } catch {
            
        }
        if (!version) {
            const m =
                body.match(/v\d+\.\d+\.\d+[-\w.]*/) ||
                body.match(/"(?:version|tag|release)"\s*:\s*"([^"]+)"/i) ||
                body.match(/<title>([^<]{0,80})<\/title>/i);
            version = m ? (m[1] || m[0]).trim() : '';
        }
        return { online: true, version, error: '' };
    } catch (e) {
        const msg = e.name === 'AbortError' ? '探测超时' : e.message || String(e);
        return { online: false, version: '', error: msg };
    } finally {
        clearTimeout(timer);
    }
}

export function describeSceError(status, body) {
    const clean = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) return `转换后端返回 HTTP ${status}`;
    return `转换后端返回 HTTP ${status}：${clean}`;
}
