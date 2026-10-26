// URI 分享链接 → mihomo(Clash)proxy 对象。
//
// 背景:订阅混源时(URI 源 + Clash YAML 源),输出通道必须统一成一种格式。
// 纯 YAML(mieru 等 mihomo 专属协议没有分享链接格式)只能走 Clash YAML,
// 所以 URI 节点也要能转成 Clash 对象。
//
// 映射逻辑移植自 D:/project/mihomo-provider/convert_nodes.py(逐节点用
// 真实 mihomo v1.19.33 延迟探测验证 30/30 通过),字段名以 mihomo 官方
// wiki(wiki.metacubex.one)与源码为准。踩过的坑:
//   · tuic 分隔冒号写成 %3A → userinfo 要解码后按第一个冒号拆分
//   · hysteria2 pinSHA256(裸 hex)→ fingerprint,mihomo 会去冒号后按 hex 比对
//   · vless encryption(mlkem768...)原样透传,mihomo 原生支持 VLESS Encryption
//   · xhttp → network: xhttp + xhttp-opts{path,host,mode}
//   · anytls 的 pcs 参数 mihomo 无对应字段,丢弃(不影响连通)
// 转换失败的协议(ssr / wireguard / ssh 等复杂格式)返回 null,由调用方
// 丢弃并计数 —— 宁缺毋滥,半截对象会让 mihomo 拒载整个配置。

// query string → 单值 Map(同名参数取第一个,与 python parse_qs 行为一致)
function qs(searchParams) {
    const out = {};
    for (const [k, v] of searchParams) {
        if (!(k in out)) out[k] = v;
    }
    return out;
}

// mihomo 的 server 字段要裸 IPv6 地址(不带方括号)
function cleanHost(host) {
    return host && host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host || '';
}

function truthy(v) {
    return v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes';
}

// alpn 参数:h3 / h2,http/1.1(逗号分隔)→ mihomo 的数组
function alpnList(v) {
    if (!v) return undefined;
    const arr = v.split(',').map((x) => x.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
}

// tls/reality 公共字段(security=tls|reality 时)
function applyTls(out, p) {
    out.tls = true;
    if (p.sni) out.servername = p.sni;
    if (p.fp) out['client-fingerprint'] = p.fp;
    if (truthy(p.insecure) || truthy(p.allowInsecure) || truthy(p.allow_insecure)) {
        out['skip-cert-verify'] = true;
    }
    // ECH:分享链接里是 "<解析域名>+<DoH 地址>",mihomo 的 ech-opts 只能指定
    // 解析域名;DoH 要配到 dns.nameserver(链接里 + 号后面的部分无法表达,丢弃)
    if (p.ech) {
        out['ech-opts'] = { enable: true, 'query-server-name': p.ech.split('+')[0] };
    }
    if ((p.security || '').toLowerCase() === 'reality') {
        const reality = { 'public-key': p.pbk || '' };
        if (p.sid) reality['short-id'] = p.sid;
        out['reality-opts'] = reality;
    }
}

// 传输层公共字段(type=ws/xhttp/grpc;tcp 不写 network)
function applyTransport(out, p) {
    const net = (p.type || 'tcp').toLowerCase();
    if (net === 'ws') {
        out.network = 'ws';
        const ws = { path: safeDecode(p.path || '/') };
        if (p.host) ws.headers = { Host: p.host };
        out['ws-opts'] = ws;
    } else if (net === 'xhttp') {
        out.network = 'xhttp';
        const x = { path: safeDecode(p.path || '/') };
        if (p.host) x.host = p.host;
        if (p.mode) x.mode = p.mode; // auto / stream-one / stream-up / packet-up
        out['xhttp-opts'] = x;
    } else if (net === 'grpc') {
        out.network = 'grpc';
        out['grpc-opts'] = { 'grpc-service-name': safeDecode(p.serviceName || p.path || '') };
    }
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

// vless://uuid@host:port?flow&encryption&security&sni&fp&pbk&sid&type&path&host#name
function buildVless(u, name) {
    const p = qs(u.searchParams);
    const out = {
        name,
        type: 'vless',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        uuid: safeDecode(decodeUser(u, false)),
        udp: true,
    };
    if (p.flow) out.flow = p.flow;
    if (p.encryption && p.encryption !== 'none') out.encryption = p.encryption;
    const sec = (p.security || 'none').toLowerCase();
    if (sec === 'tls' || sec === 'reality') applyTls(out, p);
    applyTransport(out, p);
    return out;
}

// 取 userinfo 并把 %3A 编码的分隔冒号当真冒号处理(与 serializeNodes 的
// normalizeUriUserInfo 同源问题:mihomo 的 Go 解析器不认 %3A,这里手动拆)
function decodeUser(u, singleValue) {
    const raw = safeDecode(u.username || '');
    if (singleValue) return raw;
    return raw;
}

// vmess://base64(json)
function buildVmess(link, name) {
    const b64 = link.slice('vmess://'.length).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((-b64.length % 4 + 4) % 4);
    const cfg = JSON.parse(safeDecodeB64(padded));
    const out = {
        name: String(cfg.ps || '').trim() || name,
        type: 'vmess',
        server: cleanHost(String(cfg.add || '')),
        port: parseInt(cfg.port, 10) || 0,
        uuid: String(cfg.id || ''),
        alterId: parseInt(cfg.aid, 10) || 0,
        cipher: cfg.scy || 'auto',
        udp: true,
    };
    if (String(cfg.tls || '').toLowerCase() === 'tls') {
        out.tls = true;
        if (cfg.sni) out.servername = cfg.sni;
        if (cfg.fp) out['client-fingerprint'] = cfg.fp;
        if (truthy(cfg.insecure)) out['skip-cert-verify'] = true;
    }
    const net = String(cfg.net || 'tcp').toLowerCase();
    if (net === 'ws') {
        out.network = 'ws';
        const ws = { path: cfg.path || '/' };
        if (cfg.host) ws.headers = { Host: cfg.host };
        out['ws-opts'] = ws;
    } else if (net === 'grpc') {
        out.network = 'grpc';
        out['grpc-opts'] = { 'grpc-service-name': cfg.path || '' };
    }
    return out;
}

function safeDecodeB64(s) {
    try {
        return decodeURIComponent(escape(atob(s)));
    } catch {
        return atob(s);
    }
}

// hysteria2://password@host:port?sni&insecure&pinSHA256&obfs&obfs-password&mport
function buildHysteria2(u, name) {
    const p = qs(u.searchParams);
    const out = {
        name,
        type: 'hysteria2',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        password: safeDecode(decodeUser(u, true)),
    };
    if (p.sni) out.sni = p.sni;
    if (truthy(p.insecure) || truthy(p.allow_insecure)) out['skip-cert-verify'] = true;
    if (p.pinSHA256) out.fingerprint = p.pinSHA256; // 裸 hex,mihomo 去冒号后按 32 字节比对
    if (p.obfs) {
        out.obfs = p.obfs;
        if (p['obfs-password']) out['obfs-password'] = p['obfs-password'];
    }
    if (p.mport) out.ports = p.mport; // 端口跳跃,如 38000-38888
    return out;
}

// hysteria(v1)://auth@host:port?auth&up&down&protocol&sni&insecure&alpn&mport
function buildHysteria(u, name) {
    const p = qs(u.searchParams);
    const out = {
        name,
        type: 'hysteria',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        'auth-str': p.auth || safeDecode(decodeUser(u, true)) || '',
    };
    if (p.up) out.up = p.up;
    if (p.down) out.down = p.down;
    if (p.protocol) out.protocol = p.protocol;
    if (p.sni) out.sni = p.sni;
    if (truthy(p.insecure) || truthy(p.allow_insecure)) out['skip-cert-verify'] = true;
    const alpn = alpnList(p.alpn);
    if (alpn) out.alpn = alpn;
    if (p.mport) out.ports = p.mport;
    return out;
}

// anytls://password@host:port?sni&insecure&fp(mihomo 不支持 anytls+reality)
function buildAnytls(u, name) {
    const p = qs(u.searchParams);
    const out = {
        name,
        type: 'anytls',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        password: safeDecode(decodeUser(u, true)),
        udp: true,
    };
    if (p.sni) out.sni = p.sni;
    if (p.fp) out['client-fingerprint'] = p.fp;
    if (truthy(p.insecure) || truthy(p.allow_insecure)) out['skip-cert-verify'] = true;
    // pcs 参数 mihomo 无对应字段,丢弃
    return out;
}

// tuic://uuid:password@host:port?alpn=h3&allow_insecure=1&congestion_control=bbr
function buildTuic(u, name) {
    const p = qs(u.searchParams);
    // 分隔冒号被整体编码成 %3A 时,WHATWG URL 把整段塞进 username ——
    // 解码后按第一个冒号拆成 uuid / password
    const userinfo = safeDecode(u.username || '');
    const cut = userinfo.indexOf(':');
    const uuid = cut >= 0 ? userinfo.slice(0, cut) : userinfo;
    const pwd = cut >= 0 ? userinfo.slice(cut + 1) : safeDecode(u.password || '');
    const out = {
        name,
        type: 'tuic',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        uuid,
        password: pwd,
        udp: true,
    };
    if (p.sni) out.sni = p.sni;
    const alpn = alpnList(p.alpn);
    if (alpn) out.alpn = alpn; // h3 = QUIC
    if (truthy(p.allow_insecure) || truthy(p.allowInsecure) || truthy(p.insecure)) {
        out['skip-cert-verify'] = true;
    }
    if (p.congestion_control) out['congestion-controller'] = p.congestion_control;
    if (p.udp_relay_mode) out['udp-relay-mode'] = p.udp_relay_mode;
    return out;
}

// trojan://password@host:port?sni&allowInsecure&type=ws&path&host&fp
function buildTrojan(u, name) {
    const p = qs(u.searchParams);
    const out = {
        name,
        type: 'trojan',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        password: safeDecode(decodeUser(u, true)),
        udp: true,
    };
    if (p.sni) out.sni = p.sni;
    if (p.fp) out['client-fingerprint'] = p.fp;
    if (truthy(p.allowInsecure) || truthy(p.allow_insecure) || truthy(p.insecure)) {
        out['skip-cert-verify'] = true;
    }
    const alpn = alpnList(p.alpn);
    if (alpn) out.alpn = alpn;
    applyTransport(out, p);
    return out;
}

// ss://base64(method:password)@host:port?plugin=...#name(SIP002)
function buildSs(u, name) {
    // userinfo 可能是 base64url(method:password)或明文 method:password
    let userinfo = safeDecode(u.username || '');
    if (u.password) userinfo += ':' + safeDecode(u.password);
    let method = '';
    let password = '';
    if (!userinfo.includes(':') || /%/.test(u.username || '')) {
        // 先按 base64 解码一次;解不出再按明文 user:pass 处理
        const dec = tryB64(userinfo);
        if (dec && dec.includes(':')) {
            const cut = dec.indexOf(':');
            method = dec.slice(0, cut);
            password = dec.slice(cut + 1);
        }
    }
    if (!method) {
        const cut = userinfo.indexOf(':');
        if (cut < 0) return null; // 拆不出 method:password,放弃
        method = userinfo.slice(0, cut);
        password = userinfo.slice(cut + 1);
    }
    const out = {
        name,
        type: 'ss',
        server: cleanHost(u.hostname),
        port: Number(u.port),
        cipher: method,
        password,
        udp: true,
    };
    // plugin=obfs-local;obfs=http;obfs-host=xxx 或 v2ray-plugin;mode=websocket;host=xxx
    if (u.searchParams.get('plugin')) {
        const parts = safeDecode(u.searchParams.get('plugin')).split(';');
        const plugin = parts[0] || '';
        const opts = {};
        for (const kv of parts.slice(1)) {
            const eq = kv.indexOf('=');
            if (eq > 0) opts[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        if (/obfs/.test(plugin)) {
            out.plugin = 'obfs';
            out['plugin-opts'] = { mode: opts.obfs || 'http', host: opts['obfs-host'] || '' };
        } else if (/v2ray-plugin/.test(plugin)) {
            out.plugin = 'v2ray-plugin';
            out['plugin-opts'] = { mode: opts.mode === 'quic' ? 'quic' : 'websocket' };
            if (opts.host) out['plugin-opts'].host = opts.host;
            if (opts.path) out['plugin-opts'].path = opts.path;
            if (opts.tls === 'true' || opts.tls === '1') out['plugin-opts'].tls = true;
        }
        // 其他插件(sip003 自定义)不映射,原样字段缺失交给调用方判断
    }
    return out;
}

function tryB64(s) {
    try {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        const dec = atob(b64 + '='.repeat((-b64.length % 4 + 4) % 4));
        return /^[\x20-\x7e]+$/.test(dec) ? dec : null;
    } catch {
        return null;
    }
}

// socks5/http(s)://user:pass@host:port
function buildSocksHttp(u, name, type) {
    const out = {
        name,
        type,
        server: cleanHost(u.hostname),
        port: Number(u.port),
        udp: type === 'socks5',
    };
    const userinfo = safeDecode(u.username || '');
    if (userinfo) {
        const cut = userinfo.indexOf(':');
        out.username = cut >= 0 ? userinfo.slice(0, cut) : userinfo;
        out.password = cut >= 0 ? userinfo.slice(cut + 1) : safeDecode(u.password || '');
    }
    if (type.startsWith('http') && /443/.test(u.port || '')) out.tls = true;
    return out;
}

/**
 * 单条 URI → mihomo proxy 对象;无法安全转换返回 null。
 * @param {string} raw 原始分享链接(vless:// / vmess:// / ...)
 * @param {string} name 节点名(已过重命名算子,优先用它的当前名)
 */
export function uriToClashObj(raw, name) {
    const line = String(raw || '').trim();
    const idx = line.indexOf('://');
    if (idx <= 0) return null;
    const scheme = line.slice(0, idx).toLowerCase();
    try {
        if (scheme === 'vmess') return buildVmess(line, name);
        if (!/^https?:/.test(line) && !KNOWN.includes(scheme)) return null;
        const u = new URL(line);
        if (!u.hostname || !u.port) return null;
        switch (scheme) {
            case 'vless': return buildVless(u, name);
            case 'hysteria2': case 'hy2': return buildHysteria2(u, name);
            case 'hysteria': return buildHysteria(u, name);
            case 'anytls': return buildAnytls(u, name);
            case 'tuic': return buildTuic(u, name);
            case 'trojan': return buildTrojan(u, name);
            case 'ss': return buildSs(u, name);
            case 'socks': case 'socks5': return buildSocksHttp(u, name, 'socks5');
            case 'http': case 'https': return buildSocksHttp(u, name, 'http');
            default: return null;
        }
    } catch {
        return null;
    }
}

// WHATWG URL 对 http/https 是 special scheme,单独放行;其余按白名单
const KNOWN = ['vless', 'hysteria2', 'hy2', 'hysteria', 'anytls', 'tuic', 'trojan', 'ss', 'socks', 'socks5'];

/**
 * mihomo 对 mieru 的 transport 源码硬校验:必须大写 TCP/UDP,小写直接报错。
 * 输出前统一归一化(用户 YAML 里常见小写)。
 */
export function normalizeMieruTransport(obj) {
    if (obj && obj.type === 'mieru' && obj.transport) {
        obj.transport = String(obj.transport).toUpperCase();
    }
    return obj;
}