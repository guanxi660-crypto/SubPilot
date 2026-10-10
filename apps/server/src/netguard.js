// 出网取源的统一守卫（SSRF 防护）。
//
// 背景（审计 M2）：此前只有 WebDAV 的目标地址做了校验，而 `/sub`、`/feed`、
// `/download`、`/api/preview/*` 都会拉取**用户提供的任意 URL**；而且那套校验
// 只判字面 IP、不解析域名、也不复查 302 跳转 —— 等于把服务端当成任意请求代理。
//
// 这里把守卫收敛成三件事，所有出网路径共用：
//   1. checkUrlSync —— 纯字面检查：协议 / 主机名黑名单 / 字面私网 IP / 内嵌凭据
//   2. checkUrl     —— 在 1 之上，若调用方提供了 DNS 解析器，再复核解析结果
//   3. safeFetch    —— 不把跟随跳转交给运行时，而是自己逐跳校验后再跟随
//
// 为什么必须自己跟随跳转：`redirect: 'follow'` 时，第一跳通过校验、第二跳落到
// 内网地址，运行时不会告诉我们。改成 `redirect: 'manual'` 后我们能在每一跳前
// 重新跑一遍校验。**实测确认**：Cloudflare Workers（workerd）对 manual 返回真实
// 302 且 Location 可读（type 为 default，不是 opaque），Node/undici 同理。
//
// ⚠️ 域名解析复核只在**提供了解析器**时生效（自建 Node 侧注入 env.RESOLVE_HOST）。
// Workers 运行时拿不到 DNS 查询能力，所以那一侧只做字面检查 —— 能挡住「直接填
// 内网 IP」和「填内网域名」，挡不住「公网域名解析到内网」这种 DNS rebinding。
//
// ⚠️ 另一个会让复核「形同虚设」的情况：本机 DNS 是 Clash / mihomo 的 fake-IP
// 模式时，所有域名都解析到 198.18.0.0/15 的占位地址，复核一律跳过（见 isFakeIp）。
// 此时守卫退化成「字面检查」，与 Workers 侧一致。
//
// 逃生开关：`SUBPILOT_ALLOW_PRIVATE_FETCH=1`（Worker 的 vars / Node 的环境变量）
// 会跳过「私网地址」判定，协议与格式检查仍然生效。给「SCE / WebDAV / 大模型都跑在
// 内网」的自建部署用。默认关闭。

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** 云厂商元数据服务与常见本机别名。字面 IP 形式也列在这里，双保险。 */
const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data', // AWS 的老别名
    '169.254.169.254',
    '169.254.170.2', // ECS 任务元数据
    '100.100.100.200', // 阿里云
    'fd00:ec2::254', // AWS IPv6
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

/** 去掉 IPv6 的方括号并转小写 */
function bareHost(host) {
    return String(host || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
}

/**
 * 是不是 fake-IP 占位地址（198.18.0.0/15）。
 *
 * Clash / mihomo / Surge 的 TUN 模式默认拿这个段做「假 IP」：域名不真的解析，
 * 而是映射成这个区间里的一个占位地址，真正的连接由代理按域名去做。
 *
 * ⚠️ 为什么必须在**域名解析复核**里放过它，而在**字面地址**检查里继续拦：
 * 这类代理在国内自建部署里极其常见。一旦把 198.18/15 一律当内网，
 * 「域名解析到内网」这条就会命中**每一个域名** —— 本机实测
 * `example.com → 198.18.14.153`、`github.com → 198.18.0.36`，等于把整个出网
 * 功能打死（回归脚本里「透传路径真实调用了 SCE」就是这么挂的）。
 *
 * 放过它并不开洞：RFC 2544 保留段不会分配给真实主机、不可路由，攻击者把域名
 * 指到这里也连不到任何东西；而 URL 里**直接写** `http://198.18.0.1/` 依然会被
 * 下面的字面检查拦下。
 */
function isFakeIp(host) {
    return /^198\.1[89]\.\d{1,3}\.\d{1,3}$/.test(bareHost(host));
}

/**
 * 是否私网 / 环回 / 链路本地 / 保留地址。
 *
 * 传入的 host 一定是**已经过 WHATWG URL 归一化**的（`new URL()` 会把
 * `2130706433`、`0x7f000001`、`0177.0.0.1`、`127.1` 全部规范化成 `127.0.0.1`，
 * 把 IPv4-mapped IPv6 规范化成 `[::ffff:7f00:1]`），所以这里只需要处理
 * 规范形式 —— 实测过这几种混淆写法都落在下面两个分支里。
 */
export function isPrivateIp(host) {
    const h = bareHost(host);

    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const c = Number(m[3]);
        if ([a, b, c, Number(m[4])].some((n) => n > 255)) return false;
        if (a === 0) return true; // 0.0.0.0/8
        if (a === 10) return true; // 10/8
        if (a === 127) return true; // 127/8 环回
        if (a === 169 && b === 254) return true; // 169.254/16 链路本地（云元数据）
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
        if (a === 192 && b === 168) return true; // 192.168/16
        if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
        if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
        if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
        if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
        if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
        if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
        if (a >= 224) return true; // 组播 224/4 + 保留 240/4（含 255.255.255.255）
        return false;
    }

    if (!h.includes(':')) return false;

    if (h === '::1' || h === '::') return true;

    // IPv4-mapped / IPv4-compatible：把尾部 32 位当 IPv4 再判一次
    const mappedDotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isPrivateIp(mappedDotted[1]);
    const mappedHex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const n = (((parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16)) >>> 0);
        return isPrivateIp(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }

    if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // fe80::/10 链路本地
    if (/^ff[0-9a-f]{2}:/.test(h)) return true; // ff00::/8 组播
    if (/^2001:db8:/.test(h)) return true; // 文档用
    if (/^64:ff9b:/.test(h)) return true; // NAT64
    return false;
}

/**
 * 字面校验（同步、不发网络请求）。
 * @returns {string} 错误信息；空串表示通过
 */
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
    // 内嵌凭据（https://user:pass@host/）容易被用来伪装主机，也常常是钓鱼链接的特征
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

/**
 * 字面校验 + 可选 DNS 复核（异步）。
 * `resolve(host)` 返回 IP 字符串数组；不传则跳过复核（Workers 侧就是这种）。
 * @returns {Promise<string>} 错误信息；空串表示通过
 */
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
    // 字面 IP 上面已经判过，不需要也不该去解析
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return '';

    let ips;
    try {
        ips = await resolve(host);
    } catch {
        return `${label}的域名解析失败`;
    }
    if (!Array.isArray(ips) || !ips.length) return `${label}的域名解析不到地址`;
    for (const ip of ips) {
        // fake-IP 占位地址直接跳过，见 isFakeIp 的说明。注意这里**不** return：
        // 一个域名可能同时解析出 fake-IP 和真实私网地址，后者仍要拦。
        if (isFakeIp(ip)) continue;
        if (isPrivateIp(ip)) return '域名解析到内网 / 环回地址，已拒绝（可能是 DNS rebinding）';
    }
    return '';
}

/** 从 env 里取守卫选项。escape hatch 见文件头注释。 */
export function ssrfOptions(env, overrides = {}) {
    return {
        allowPrivate: String(env?.SUBPILOT_ALLOW_PRIVATE_FETCH ?? '') === '1',
        resolve: env?.RESOLVE_HOST,
        ...overrides,
    };
}

/** 守卫拒绝时抛出的错误，带 code 便于调用方区分「被拦」与「网络失败」 */
export class SsrfBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SsrfBlockedError';
        this.code = 'SSRF_BLOCKED';
        // 被守卫拦下是**预期结果**，不是内部故障：让入口把它翻成 400 而不是 500。
        // 有些调用点（比如 /feed 的内部取源）没有逐层 try/catch，会一路冒到入口。
        this.status = 400;
        this.expose = true;
    }
}

/**
 * 带守卫的 fetch：每一跳（含重定向目标）都先校验再请求。
 *
 * 与直接 `fetch(url, { redirect: 'follow' })` 的差别就在跳转上 —— 后者只看得到
 * 第一跳的地址，第二跳可以落到 169.254.169.254 而我们毫不知情。
 */
export async function safeFetch(rawUrl, init = {}, opts = {}) {
    const { allowHttp = false, allowPrivate = false, resolve, label = '地址', maxRedirects = MAX_REDIRECTS } = opts;

    let current = String(rawUrl ?? '').trim();
    let next = { ...init };

    for (let hop = 0; hop <= maxRedirects; hop++) {
        const bad = await checkUrl(current, { allowHttp, allowPrivate, resolve, label });
        if (bad) throw new SsrfBlockedError(bad);

        const res = await fetch(current, { ...next, redirect: 'manual' });

        // 运行时不暴露重定向目标（spec 里的 opaque-redirect）时无法校验 —— 拒绝，
        // 不猜。实测 Workers 与 Node 都会给出真实 3xx，这条只是兜底。
        if (res.status === 0 || res.type === 'opaqueredirect') {
            throw new SsrfBlockedError(`${label}发生了无法校验的重定向，已拒绝跟随`);
        }
        if (!REDIRECT_STATUS.has(res.status)) return res;

        const loc = res.headers.get('Location');
        if (!loc) return res; // 3xx 但没给目标，原样交回给调用方判断

        // 丢掉这一跳的响应体，别把连接悬着
        try {
            await res.body?.cancel();
        } catch {
            /* 没有 body 或已关闭 */
        }

        const method = String(next.method || 'GET').toUpperCase();
        // 303 一律改 GET；301 / 302 对非 GET/HEAD 按浏览器惯例也改 GET（307 / 308 保留）
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
