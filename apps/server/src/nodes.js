import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { b64decode, b64encode, looksLikeBase64 } from './util.js';

const KNOWN_SCHEMES = [
    'ss', 'ssr', 'ssd', 'vmess', 'vless', 'trojan', 'trojan-go',
    'hysteria', 'hysteria2', 'hy2', 'tuic', 'anytls', 'snell',
    'socks', 'socks5', 'http', 'https', 'wireguard', 'ssh', 'mieru',
];

export function detectFormat(text) {
    const t = String(text ?? '').trim();
    if (!t) return 'empty';
    
    
    if (/(^|\n)[ \t]*proxies[ \t]*:/m.test(t)) return 'clash';
    if (t.startsWith('{') && /"proxies"\s*:/.test(t)) return 'clash';
    if (t.includes('://')) return 'uri';
    if (looksLikeBase64(t)) {
        const dec = b64decode(t);
        if (dec && dec.includes('://')) return 'uri-base64';
    }
    return 'unknown';
}

function splitUri(line) {
    const idx = line.indexOf('://');
    if (idx < 0) return null;
    const scheme = line.slice(0, idx).toLowerCase();
    let rest = line.slice(idx + 3);

    let fragment = '';
    const h = rest.indexOf('#');
    if (h >= 0) {
        fragment = safeDecode(rest.slice(h + 1));
        rest = rest.slice(0, h);
    }
    let query = '';
    const q = rest.indexOf('?');
    if (q >= 0) {
        query = rest.slice(q + 1);
        rest = rest.slice(0, q);
    }
    return { scheme, rest, query, fragment };
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function hostPort(s) {
    const at = s.lastIndexOf('@');
    const hp = at >= 0 ? s.slice(at + 1) : s;
    if (hp.startsWith('[')) {
        const end = hp.indexOf(']');
        if (end > 0) {
            return { host: hp.slice(1, end), port: parseInt(hp.slice(end + 2), 10) || 0 };
        }
    }
    const c = hp.lastIndexOf(':');
    if (c < 0) return { host: hp, port: 0 };
    return { host: hp.slice(0, c), port: parseInt(hp.slice(c + 1), 10) || 0 };
}

export function parseUri(line, index = 0) {
    const raw = String(line || '').trim();
    const parts = splitUri(raw);
    if (!parts) return null;
    const { scheme, rest, query, fragment } = parts;

    let type = scheme;
    let name = fragment;
    let server = '';
    let port = 0;
    let extra = {};

    if (scheme === 'vmess') {
        
        const obj = safeJson(b64decode(rest));
        if (!obj) return null;
        type = 'vmess';
        name = fragment || obj.ps || obj.remark || '';
        server = obj.add || '';
        port = parseInt(obj.port, 10) || 0;
        extra = obj;
    } else if (scheme === 'ssr') {
        
        const dec = b64decode(rest);
        if (!dec) return null;
        const [main, paramStr = ''] = dec.split('/?');
        const seg = main.split(':');
        if (seg.length < 6) return null;
        const params = new URLSearchParams(paramStr);
        type = 'ssr';
        server = seg[0];
        port = parseInt(seg[1], 10) || 0;
        name = fragment || b64decode(params.get('remarks') || '') || '';
    } else if (scheme === 'ss') {
        let s = rest;
        const at = s.lastIndexOf('@');
        if (at < 0) {
            
            const dec = b64decode(s);
            if (dec.includes('@')) s = dec;
            else return null;
        } else {
            const ui = s.slice(0, at);
            
            if (!ui.includes(':')) {
                const dec = b64decode(ui);
                if (dec.includes(':')) s = dec + s.slice(at);
            }
        }
        const { host, port: p } = hostPort(s);
        type = 'ss';
        server = host;
        port = p;
        name = fragment;
    } else {
        const { host, port: p } = hostPort(rest);
        type = scheme === 'hy2' ? 'hysteria2' : scheme;
        server = host;
        port = p;
        name = fragment;
        if (query) {
            const qs = new URLSearchParams(query);
            if (qs.get('sni')) extra.sni = qs.get('sni');
        }
    }

    return {
        id: `u${index}-${hash8(raw)}`,
        format: 'uri',
        type,
        name: name || `${type}-${index + 1}`,
        server,
        port,
        raw,
        extra,
    };
}

function hash8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function safeJson(s) {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

export function parseNodes(text) {
    const fmt = detectFormat(text);
    if (fmt === 'empty') return { format: 'unknown', nodes: [], error: '内容为空' };

    if (fmt === 'clash') {
        try {
            const doc = parseYaml(text);
            const list = Array.isArray(doc?.proxies) ? doc.proxies : [];
            const nodes = list
                .filter((p) => p && typeof p === 'object' && p.name)
                .map((p, i) => ({
                    id: `c${i}-${hash8(JSON.stringify(p).slice(0, 200))}`,
                    format: 'clash',
                    type: String(p.type || 'unknown').toLowerCase(),
                    name: String(p.name),
                    server: String(p.server ?? ''),
                    port: parseInt(p.port, 10) || 0,
                    obj: p,
                }));
            return { format: 'clash', nodes };
        } catch (e) {
            return { format: 'clash', nodes: [], error: `Clash YAML 解析失败：${e.message}` };
        }
    }

    
    const body = fmt === 'uri-base64' ? b64decode(text) : text;
    const nodes = [];
    for (const rawLine of body.split(/[\r\n]+/)) {
        const line = rawLine.trim();
        if (!line || !line.includes('://')) continue;
        const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
        if (!KNOWN_SCHEMES.includes(scheme)) continue;
        const n = parseUri(line, nodes.length);
        if (n) nodes.push(n);
    }
    return { format: 'uri', nodes };
}

export function renameNode(node, newName) {
    node.name = newName;
    if (node.format === 'clash') {
        node.obj.name = newName;
        return;
    }
    node.raw = rewriteUriName(node.raw, node.type, newName);
}

function rewriteUriName(line, type, name) {
    if (type === 'vmess') {
        const idx = line.indexOf('://');
        const obj = safeJson(b64decode(line.slice(idx + 3)));
        if (obj) {
            obj.ps = name;
            return `vmess://${b64encode(JSON.stringify(obj))}`;
        }
    }
    if (type === 'ssr') {
        const idx = line.indexOf('://');
        const dec = b64decode(line.slice(idx + 3));
        if (dec) {
            const [main, paramStr = ''] = dec.split('/?');
            const params = new URLSearchParams(paramStr);
            params.set('remarks', b64urlRaw(name));
            return `ssr://${b64urlRaw(`${main}/?${params.toString()}`)}`;
        }
    }
    
    const h = line.indexOf('#');
    const base = h >= 0 ? line.slice(0, h) : line;
    return `${base}#${encodeURIComponent(name)}`;
}

function b64urlRaw(str) {
    return b64encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function serializeNodes(nodes, format) {
    if (format === 'clash') {
        const proxies = nodes.map((n) => n.obj || { name: n.name, type: n.type, server: n.server, port: n.port });
        return stringifyYaml({ proxies });
    }
    return b64encode(nodes.map((n) => n.raw).filter(Boolean).join('\n'));
}

export function summarize(nodes) {
    return nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        server: n.server,
        port: n.port,
    }));
}

export const REGIONS = [
    { code: 'HK', flag: '🇭🇰', kw: ['香港', 'hongkong', 'hong kong', 'hk', 'hkg', '深港', '沪港', '京港', '🇭🇰'] },
    { code: 'TW', flag: '🇹🇼', kw: ['台湾', '台灣', 'taiwan', 'tw', 'twn', 'tpe', '🇹🇼', '新北', '彰化'] },
    { code: 'JP', flag: '🇯🇵', kw: ['日本', 'japan', 'jp', 'jpn', '东京', '東京', '大阪', '埼玉', '🇯🇵'] },
    { code: 'SG', flag: '🇸🇬', kw: ['新加坡', 'singapore', 'sg', 'sgp', '狮城', '🇸🇬'] },
    { code: 'US', flag: '🇺🇸', kw: ['美国', '美國', 'united states', 'usa', 'us', '🇺🇸', '洛杉矶', '圣何塞', '西雅图', '硅谷', '达拉斯'] },
    { code: 'KR', flag: '🇰🇷', kw: ['韩国', '韓國', 'korea', 'kr', 'kor', '首尔', '首爾', '🇰🇷'] },
    { code: 'MO', flag: '🇲🇴', kw: ['澳门', '澳門', 'macau', 'macao', 'mo', '🇲🇴'] },
    { code: 'GB', flag: '🇬🇧', kw: ['英国', '英國', 'united kingdom', 'uk', 'gb', 'gbr', '伦敦', '🇬🇧'] },
    { code: 'DE', flag: '🇩🇪', kw: ['德国', '德國', 'germany', 'de', 'deu', '法兰克福', '🇩🇪'] },
    { code: 'FR', flag: '🇫🇷', kw: ['法国', '法國', 'france', 'fr', 'fra', '巴黎', '🇫🇷'] },
    { code: 'NL', flag: '🇳🇱', kw: ['荷兰', '荷蘭', 'netherlands', 'nl', 'nld', '阿姆斯特丹', '🇳🇱'] },
    { code: 'FI', flag: '🇫🇮', kw: ['芬兰', '芬蘭', 'finland', 'fi', 'fin', '赫尔辛基', '🇫🇮'] },
    { code: 'SE', flag: '🇸🇪', kw: ['瑞典', 'sweden', 'se', 'swe', '斯德哥尔摩', '🇸🇪'] },
    { code: 'NO', flag: '🇳🇴', kw: ['挪威', 'norway', 'no', 'nor', '奥斯陆', '🇳🇴'] },
    { code: 'DK', flag: '🇩🇰', kw: ['丹麦', '丹麥', 'denmark', 'dk', 'dnk', '🇩🇰'] },
    { code: 'IS', flag: '🇮🇸', kw: ['冰岛', '冰島', 'iceland', 'is', '🇮🇸'] },
    { code: 'IE', flag: '🇮🇪', kw: ['爱尔兰', '愛爾蘭', 'ireland', 'ie', 'irl', '都柏林', '🇮🇪'] },
    { code: 'AT', flag: '🇦🇹', kw: ['奥地利', '奧地利', 'austria', 'at', 'aut', '维也纳', '🇦🇹'] },
    { code: 'CH', flag: '🇨🇭', kw: ['瑞士', 'switzerland', 'ch', 'che', '苏黎世', '🇨🇭'] },
    { code: 'PT', flag: '🇵🇹', kw: ['葡萄牙', 'portugal', 'pt', 'prt', '里斯本', '🇵🇹'] },
    { code: 'PL', flag: '🇵🇱', kw: ['波兰', '波蘭', 'poland', 'pl', 'pol', '华沙', '🇵🇱'] },
    { code: 'CZ', flag: '🇨🇿', kw: ['捷克', 'czech', 'cz', 'cze', '布拉格', '🇨🇿'] },
    { code: 'GR', flag: '🇬🇷', kw: ['希腊', '希臘', 'greece', 'gr', 'grc', '🇬🇷'] },
    { code: 'RO', flag: '🇷🇴', kw: ['罗马尼亚', '羅馬尼亞', 'romania', 'ro', 'rou', '🇷🇴'] },
    { code: 'HU', flag: '🇭🇺', kw: ['匈牙利', 'hungary', 'hu', 'hun', '布达佩斯', '🇭🇺'] },
    { code: 'RU', flag: '🇷🇺', kw: ['俄罗斯', '俄羅斯', 'russia', 'ru', 'rus', '莫斯科', '🇷🇺'] },
    { code: 'UA', flag: '🇺🇦', kw: ['乌克兰', '烏克蘭', 'ukraine', 'ua', 'ukr', '基辅', '🇺🇦'] },
    { code: 'KZ', flag: '🇰🇿', kw: ['哈萨克', '哈薩克', 'kazakhstan', 'kz', 'kaz', '🇰🇿'] },
    { code: 'CA', flag: '🇨🇦', kw: ['加拿大', 'canada', 'ca', 'can', '🇨🇦'] },
    { code: 'AU', flag: '🇦🇺', kw: ['澳大利亚', '澳洲', 'australia', 'au', 'aus', '悉尼', '🇦🇺'] },
    { code: 'NZ', flag: '🇳🇿', kw: ['新西兰', '新西蘭', 'new zealand', 'nz', '🇳🇿'] },
    { code: 'IN', flag: '🇮🇳', kw: ['印度', 'india', 'in', 'ind', '孟买', '🇮🇳'] },
    { code: 'TR', flag: '🇹🇷', kw: ['土耳其', 'turkey', 'tr', 'tur', '伊斯坦布尔', '🇹🇷'] },
    { code: 'BR', flag: '🇧🇷', kw: ['巴西', 'brazil', 'br', 'bra', '圣保罗', '🇧🇷'] },
    { code: 'AR', flag: '🇦🇷', kw: ['阿根廷', 'argentina', 'ar', 'arg', '🇦🇷'] },
    { code: 'MX', flag: '🇲🇽', kw: ['墨西哥', 'mexico', 'mx', '🇲🇽'] },
    { code: 'IL', flag: '🇮🇱', kw: ['以色列', 'israel', 'il', '🇮🇱'] },
    { code: 'AE', flag: '🇦🇪', kw: ['阿联酋', '阿聯酋', 'united arab emirates', 'uae', 'ae', '迪拜', '🇦🇪'] },
    { code: 'ZA', flag: '🇿🇦', kw: ['南非', 'south africa', 'za', '🇿🇦'] },
    { code: 'EG', flag: '🇪🇬', kw: ['埃及', 'egypt', 'eg', '🇪🇬'] },
    { code: 'IT', flag: '🇮🇹', kw: ['意大利', '義大利', 'italy', 'it', 'ita', '米兰', '🇮🇹'] },
    { code: 'ES', flag: '🇪🇸', kw: ['西班牙', 'spain', 'es', 'esp', '马德里', '🇪🇸'] },
    { code: 'MY', flag: '🇲🇾', kw: ['马来西亚', '馬來西亞', 'malaysia', 'my', 'mys', '🇲🇾'] },
    { code: 'TH', flag: '🇹🇭', kw: ['泰国', '泰國', 'thailand', 'th', 'tha', '曼谷', '🇹🇭'] },
    { code: 'VN', flag: '🇻🇳', kw: ['越南', 'vietnam', 'vn', 'vnm', '🇻🇳'] },
    { code: 'PH', flag: '🇵🇭', kw: ['菲律宾', '菲律賓', 'philippines', 'ph', 'phl', '🇵🇭'] },
    { code: 'ID', flag: '🇮🇩', kw: ['印尼', '印度尼西亚', 'indonesia', 'id', 'idn', '雅加达', '🇮🇩'] },
    { code: 'KH', flag: '🇰🇭', kw: ['柬埔寨', 'cambodia', 'kh', '🇰🇭'] },
    { code: 'MM', flag: '🇲🇲', kw: ['缅甸', '緬甸', 'myanmar', 'mm', '🇲🇲'] },
    { code: 'BD', flag: '🇧🇩', kw: ['孟加拉', 'bangladesh', 'bd', '🇧🇩'] },
    { code: 'PK', flag: '🇵🇰', kw: ['巴基斯坦', 'pakistan', 'pk', '🇵🇰'] },
    { code: 'LK', flag: '🇱🇰', kw: ['斯里兰卡', '斯里蘭卡', 'sri lanka', 'lk', '🇱🇰'] },
    { code: 'MN', flag: '🇲🇳', kw: ['蒙古', 'mongolia', 'mn', '🇲🇳'] },
    { code: 'CN', flag: '🇨🇳', kw: ['中国', '中國', 'china', 'cn', 'chn', '回国', '國內', '国内', '🇨🇳'] },
];

const MATCHERS = REGIONS.map((r) => ({
    code: r.code,
    flag: r.flag,
    
    loose: r.kw.filter((k) => !/^[a-z]{1,3}$/.test(k)).map((k) => k.toLowerCase()),
    strict: r.kw
        .filter((k) => /^[a-z]{1,3}$/.test(k))
        .map((k) => ({ kw: k.toLowerCase(), re: new RegExp(`(^|[^a-z])${k}([^a-z]|$)`, 'i') })),
}));

export function regionOf(name) {
    const s = String(name || '').toLowerCase();
    if (!s) return '';
    let best = null;
    const consider = (code, len) => {
        if (!best || len > best.len) best = { code, len };
    };
    for (const m of MATCHERS) {
        for (const k of m.loose) {
            if (s.includes(k)) consider(m.code, k.length);
        }
        for (const { kw, re } of m.strict) {
            if (re.test(s)) consider(m.code, kw.length);
        }
    }
    return best ? best.code : '';
}

export function flagOf(code) {
    return REGIONS.find((r) => r.code === code)?.flag || '';
}
