
import { fail, ok, isPlainObject, maskSecret } from './util.js';
import { loadSnapshot, mutate } from './storage.js';
import { exportBundle, mergeBundle } from './api.js';
import { checkUrl, safeFetch, ssrfOptions } from './netguard.js';

const BACKUP_FILE = 'subpilotx-backup.json';
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const SYNC_TIMEOUT = 20000;


async function fetchWithTimeout(url, init = {}, timeoutMs = SYNC_TIMEOUT, ssrf = {}) {
    try {
        
        
        return await safeFetch(
            url,
            { ...init, signal: AbortSignal.timeout(timeoutMs) },
            { label: '同步地址', ...ssrf },
        );
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        }
        throw e;
    }
}






function webdavGuard(env) {
    const o = ssrfOptions(env, { label: 'WebDAV 地址' });
    o.allowHttp = o.allowPrivate;
    return o;
}



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
        
    }
    if (!gistId && j.id) {
        gistId = j.id;
        
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
    const bad = await checkUrl(cfg.url, webdavGuard(env));
    if (bad) return fail(bad, 400);
    try {
        
        const res = await fetchWithTimeout(
            davUrl(cfg),
            { method: 'PROPFIND', headers: { ...davHeaders(cfg), Depth: '0' } },
            SYNC_TIMEOUT,
            webdavGuard(env),
        );
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
    const bad = await checkUrl(cfg.url, webdavGuard(env));
    if (bad) return fail(bad, 400);

    const payload = JSON.stringify(exportBundle(snap), null, 0);
    if (payload.length > MAX_BACKUP_BYTES) return fail('备份体积超过 20MiB 上限', 413);

    try {
        
        if (cfg.dir) {
            await fetchWithTimeout(
                davUrl(cfg),
                { method: 'MKCOL', headers: davHeaders(cfg) },
                SYNC_TIMEOUT,
                webdavGuard(env),
            ).catch(() => {});
        }
        const res = await fetchWithTimeout(
            `${davUrl(cfg)}/${BACKUP_FILE}`,
            {
                method: 'PUT',
                headers: { ...davHeaders(cfg), 'Content-Type': 'application/json' },
                body: payload,
            },
            SYNC_TIMEOUT,
            webdavGuard(env),
        );
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
    const bad = await checkUrl(cfg.url, webdavGuard(env));
    if (bad) return fail(bad, 400);
    try {
        const res = await fetchWithTimeout(
            `${davUrl(cfg)}/${BACKUP_FILE}`,
            { headers: davHeaders(cfg) },
            SYNC_TIMEOUT,
            webdavGuard(env),
        );
        if (res.status === 404) return fail('云端没有找到备份文件', 404);
        if (!res.ok) return fail(`下载失败 HTTP ${res.status}`, 502);
        const raw = await res.text();
        return applyBundle(env, raw);
    } catch (e) {
        return fail(`下载失败：${e.message || e}`, 502);
    }
}



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
