// 同步：把整站快照备份到 Gist 或 WebDAV，并支持从云端恢复。
//
// 放在服务端而不是浏览器：
//   · WebDAV 基本不给浏览器发 CORS 头，前端直连必然被拦
//   · Token / 应用密码存服务端 KV，不下发浏览器
//
// SSRF 防护是硬要求：WebDAV 地址由用户填写，必须挡住内网与云元数据地址，
// 否则这个功能会变成一个任意请求代理。

import { fail, ok, isPlainObject, maskSecret } from './util.js';
import { loadSnapshot, mutate } from './storage.js';
import { exportBundle, mergeBundle } from './api.js';

const BACKUP_FILE = 'subpilotx-backup.json';
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const SYNC_TIMEOUT = 20000;

/**
 * 带超时的 fetch。
 *
 * 同步的两个目标都在本站之外（GitHub API / 用户自建的网盘），任何一侧挂住
 * 都会把这次请求一直吊着 —— 用户在页面上只看到转圈，没有任何反馈。
 * 其余模块（pipeline / sce / telegram）都带超时，这里此前是漏的。
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = SYNC_TIMEOUT) {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        }
        throw e;
    }
}

// ---------------------------------------------------------------- SSRF 防护

const BLOCKED_HOSTS = [
    'localhost', 'metadata.google.internal', 'metadata.goog',
    '169.254.169.254', '100.100.100.200', 'fd00:ec2::254',
];

function isPrivateIp(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    // IPv4
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        return false;
    }
    // IPv6 环回 / 链路本地 / 唯一本地
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
    if (/^fe80:/i.test(h)) return true;
    return false;
}

/**
 * 校验同步目标地址。
 * 只允许 https（WebDAV 走明文等于把应用密码交给中间人）。
 */
export function assertSafeUrl(raw) {
    let u;
    try {
        u = new URL(String(raw || ''));
    } catch {
        return '地址格式不正确';
    }
    if (u.protocol !== 'https:') return '地址必须以 https:// 开头';
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(host)) return '不允许访问该主机';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
        if (isPrivateIp(host)) return '不允许访问内网或环回地址';
    }
    if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localhost')) {
        return '不允许访问内网域名';
    }
    return '';
}

// ---------------------------------------------------------------- Gist

async function gistRequest(cfg, { method = 'GET', path = '', body } = {}) {
    const res = await fetchWithTimeout(`https://api.github.com${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${cfg.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'SubPilot/0.1',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res;
}

async function gistBackup(env, snap) {
    const cfg = snap.settings.sync.gist;
    if (!cfg.token) return fail('请先填写 GitHub Token', 400);
    const payload = JSON.stringify(exportBundle(snap), null, 0);
    if (payload.length > MAX_BACKUP_BYTES) return fail('备份体积超过 20MiB 上限', 413);

    let gistId = String(cfg.gistId || '').trim();
    const body = {
        description: 'SubPilot 备份',
        public: false,
        files: { [BACKUP_FILE]: { content: payload } },
    };

    let res;
    let text;
    try {
        res = gistId
            ? await gistRequest(cfg, { method: 'PATCH', path: `/gists/${gistId}`, body })
            : await gistRequest(cfg, { method: 'POST', path: '/gists', body });
        text = await res.text();
    } catch (e) {
        return fail(`Gist 备份失败：${e.message || e}`, 502);
    }
    if (!res.ok) return fail(`Gist 备份失败 HTTP ${res.status}：${text.slice(0, 200)}`, 502);

    let j = {};
    try {
        j = JSON.parse(text);
    } catch {
        /* ignore */
    }
    if (!gistId && j.id) {
        gistId = j.id;
        // 首次备份自动记下 Gist ID，否则下次会又建一个新的
        await mutate(env, (s) => {
            s.settings.sync.gist.gistId = gistId;
        });
    }
    return ok({ gistId, url: j.html_url || `https://gist.github.com/${gistId}`, bytes: payload.length });
}

async function gistRestore(env) {
    const snap = await loadSnapshot(env);
    const cfg = snap.settings.sync.gist;
    if (!cfg.token) return fail('请先填写 GitHub Token', 400);
    if (!cfg.gistId) return fail('请先填写 Gist ID（或先执行一次备份自动创建）', 400);

    let res;
    try {
        res = await gistRequest(cfg, { path: `/gists/${cfg.gistId}` });
    } catch (e) {
        return fail(`读取 Gist 失败：${e.message || e}`, 502);
    }
    if (!res.ok) return fail(`读取 Gist 失败 HTTP ${res.status}`, 502);
    let j;
    try {
        j = await res.json();
    } catch (e) {
        return fail(`Gist 返回的不是合法 JSON：${e.message || e}`, 502);
    }
    const file = j.files?.[BACKUP_FILE] || Object.values(j.files || {})[0];
    if (!file) return fail('Gist 里没有找到备份文件', 400);

    let raw = file.content || '';
    // 超过 1MB 时 API 只给截断内容，改走 raw 链接
    if (file.truncated && file.raw_url) {
        let r2;
        try {
            r2 = await fetchWithTimeout(file.raw_url, { headers: { 'User-Agent': 'SubPilot/0.1' } });
        } catch (e) {
            return fail(`备份文件过大且 raw 拉取失败（${e.message || e}），建议改用 WebDAV`, 502);
        }
        if (!r2.ok) return fail('备份文件过大且 raw 拉取失败，建议改用 WebDAV', 502);
        raw = await r2.text();
    }
    return applyBundle(env, raw);
}

// ---------------------------------------------------------------- WebDAV

function davHeaders(cfg) {
    return {
        Authorization: `Basic ${btoa(`${cfg.user}:${cfg.pass}`)}`,
        'User-Agent': 'SubPilot/0.1',
    };
}

function davUrl(cfg) {
    const base = String(cfg.url || '').replace(/\/+$/, '');
    const dir = String(cfg.dir || '').replace(/^\/+|\/+$/g, '');
    return dir ? `${base}/${dir}` : base;
}

async function davTest(env) {
    const snap = await loadSnapshot(env);
    const cfg = snap.settings.sync.webdav;
    if (!cfg.url) return fail('请先填写 WebDAV 地址', 400);
    const bad = assertSafeUrl(cfg.url);
    if (bad) return fail(bad, 400);
    try {
        // PROPFIND 深度 0：能返回 207 就说明认证与路径都对
        const res = await fetchWithTimeout(davUrl(cfg), {
            method: 'PROPFIND',
            headers: { ...davHeaders(cfg), Depth: '0' },
        });
        if (res.status === 401 || res.status === 403) return fail('认证失败，请检查账号与应用密码', 400);
        if (res.status >= 400 && res.status !== 404) {
            return fail(`WebDAV 返回 HTTP ${res.status}`, 502);
        }
        return ok({ ok: true, status: res.status });
    } catch (e) {
        return fail(`连接失败：${e.message || e}`, 502);
    }
}

async function davBackup(env) {
    const snap = await loadSnapshot(env);
    const cfg = snap.settings.sync.webdav;
    if (!cfg.url) return fail('请先填写 WebDAV 地址', 400);
    const bad = assertSafeUrl(cfg.url);
    if (bad) return fail(bad, 400);

    const payload = JSON.stringify(exportBundle(snap), null, 0);
    if (payload.length > MAX_BACKUP_BYTES) return fail('备份体积超过 20MiB 上限', 413);

    try {
        // 目录可能不存在，MKCOL 失败（405/409 已存在）无所谓，继续 PUT
        if (cfg.dir) {
            await fetchWithTimeout(davUrl(cfg), { method: 'MKCOL', headers: davHeaders(cfg) }).catch(() => {});
        }
        const res = await fetchWithTimeout(`${davUrl(cfg)}/${BACKUP_FILE}`, {
            method: 'PUT',
            headers: { ...davHeaders(cfg), 'Content-Type': 'application/json' },
            body: payload,
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            return fail(`上传失败 HTTP ${res.status}：${t.slice(0, 200)}`, 502);
        }
        return ok({ path: `${davUrl(cfg)}/${BACKUP_FILE}`, bytes: payload.length });
    } catch (e) {
        return fail(`上传失败：${e.message || e}`, 502);
    }
}

async function davRestore(env) {
    const snap = await loadSnapshot(env);
    const cfg = snap.settings.sync.webdav;
    if (!cfg.url) return fail('请先填写 WebDAV 地址', 400);
    const bad = assertSafeUrl(cfg.url);
    if (bad) return fail(bad, 400);
    try {
        const res = await fetchWithTimeout(`${davUrl(cfg)}/${BACKUP_FILE}`, { headers: davHeaders(cfg) });
        if (res.status === 404) return fail('云端没有找到备份文件', 404);
        if (!res.ok) return fail(`下载失败 HTTP ${res.status}`, 502);
        const raw = await res.text();
        return applyBundle(env, raw);
    } catch (e) {
        return fail(`下载失败：${e.message || e}`, 502);
    }
}

// ---------------------------------------------------------------- 公共入口

async function applyBundle(env, raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return fail('备份文件不是合法 JSON', 400);
    }
    if (!isPlainObject(parsed) || parsed.app !== 'SubPilot') {
        return fail('备份文件格式不匹配（缺少 app: "SubPilot" 标记）', 400);
    }
    // mutate() 内部已经写过一次 KV 了，这里不要再写第二遍 ——
    // 快照是单键整包序列化，重复写等于把每次恢复的耗时翻倍，收益为零。
    const { result } = await mutate(env, (s) => mergeBundle(s, parsed));
    return ok(result);
}

export async function handleSync(request, env, ctx, { method, path }) {
    const seg = path.replace(/^\/api\/sync\/?/, '').split('/').filter(Boolean);

    if (seg[0] === 'config' && method === 'GET') {
        const snap = await loadSnapshot(env);
        const s = snap.settings.sync;
        return ok({
            provider: s.provider,
            // 必须带上掩码：前端占位符写的是「已保存（<mask>），留空不修改」，
            // 少了掩码就会渲染成「已保存（undefined）」——不报错，但一眼假。
            gist: {
                gistId: s.gist.gistId,
                hasToken: !!s.gist.token,
                tokenMask: maskSecret(s.gist.token),
            },
            webdav: {
                url: s.webdav.url,
                user: s.webdav.user,
                dir: s.webdav.dir,
                hasPass: !!s.webdav.pass,
                passMask: maskSecret(s.webdav.pass),
            },
        });
    }

    if (seg[0] === 'gist' && seg[1] === 'backup' && method === 'POST') {
        const snap = await loadSnapshot(env);
        return gistBackup(env, snap);
    }
    if (seg[0] === 'gist' && seg[1] === 'restore' && method === 'POST') {
        return gistRestore(env);
    }

    if (seg[0] === 'webdav' && method === 'POST') {
        if (seg[1] === 'test') return davTest(env);
        if (seg[1] === 'backup') return davBackup(env);
        if (seg[1] === 'restore') return davRestore(env);
    }

    return fail(`未知同步接口：${method} ${path}`, 404);
}
