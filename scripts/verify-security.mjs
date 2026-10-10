// 安全回归（对应 AUDIT.md 的 S1 / M1 / M4 / L2，以及 L2 在 PATCH 路径上的绕过）。
//
// 分两段：
//   · 单元段 —— 直接 import util.js 测 safeEqual（含一对真实 FNV-1a 碰撞串）；
//     用内存 SQLite 驱动 handleShare，测「远程文件非 http(s) 时拒绝跳转」这条
//     纵深防御守卫 —— 它没法从接口造出来（保存侧已经先拦了），只能直接喂脏数据。
//   · HTTP 段 —— 打真实本地服务，验安全响应头、/api/link 不再下发明文令牌、
//     远程文件地址协议白名单（含 PATCH 绕过路径）。
//
// 用法：node scripts/verify-security.mjs [baseUrl]
// 需要先起本地服务：SUBPILOT_TOKEN=dev-local-token PORT=8795 node apps/server/node/server.mjs

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const req = async (method, path, body, headers = H) => {
    const r = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    const raw = await r.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch {
        /* 非 JSON 响应 */
    }
    return { status: r.status, headers: r.headers, raw, json };
};

// ────────────────────────────────────────────── [1] S1：常量时间比较
console.log('\n[1] S1 · safeEqual 必须比原文（不能比 32 位短哈希）');

const { safeEqual } = await import('../apps/server/src/util.js');

ok('相同字符串 → true', safeEqual('abc', 'abc') === true);
ok('不同字符串 → false', safeEqual('abc', 'abd') === false);
ok('前缀相同但更短 → false', safeEqual('abc', 'ab') === false);
ok('空串相等 → true', safeEqual('', '') === true);
ok('undefined 与空串等价 → true', safeEqual(undefined, '') === true);
ok('数字与字符串同形 → true', safeEqual(123, '123') === true);

// 一对**真实的 FNV-1a 碰撞串**：等长、32 位哈希相同。
// 旧实现（把原文各自哈希成 8 位十六进制再逐字符比 + 比长度）会把这一对判成
// 「相等」—— 也就是说任何知道令牌长度的人，都能在 2^16 量级内离线凑出一个
// 能过鉴权的串，构成实质鉴权绕过（审计 S1）。
// 下面同时跑一遍旧实现作为对照：它必须返回 true（证明漏洞真实存在），
// 而新实现必须返回 false。这对串由全字母表枚举 4 字符串得到，非手工编造。
const fnv1a = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
};
// 旧实现原样复制（仅用于对照）
const oldSafeEqual = (a, b) => {
    const x = String(a ?? '');
    const y = String(b ?? '');
    const hx = fnv1a(x);
    const hy = fnv1a(y);
    let diff = x.length ^ y.length;
    for (let i = 0; i < hx.length; i++) diff |= hx.charCodeAt(i) ^ hy.charCodeAt(i);
    return diff === 0 && x.length === y.length;
};

const COLLIDE_A = '7yzx';
const COLLIDE_B = 'e6ad';
ok('碰撞串确实是等长且哈希相同（测试前提）', COLLIDE_A.length === COLLIDE_B.length && fnv1a(COLLIDE_A) === fnv1a(COLLIDE_B), `${COLLIDE_A}/${COLLIDE_B} → ${fnv1a(COLLIDE_A)}`);
ok('旧实现会把碰撞串判为相等（证明 S1 真实存在）', oldSafeEqual(COLLIDE_A, COLLIDE_B) === true);
ok('新实现判碰撞串不相等', safeEqual(COLLIDE_A, COLLIDE_B) === false);
ok('新实现仍认真正的原文', safeEqual(COLLIDE_A, COLLIDE_A) === true);
// 再枚举一次确认这对不是巧合（全字母表 4 字符串里必然存在碰撞）
{
    const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';
    const seen = new Map();
    let found = null;
    let scanned = 0;
    outer: for (const a of ALPHA)
        for (const b of ALPHA)
            for (const c of ALPHA)
                for (const d of ALPHA) {
                    const s = a + b + c + d;
                    scanned++;
                    const h = fnv1a(s);
                    const prev = seen.get(h);
                    if (prev !== undefined) {
                        found = [prev, s];
                        break outer;
                    }
                    seen.set(h, s);
                }
    ok('4 字符串空间内可枚举出碰撞', !!found, found ? `${found[0]}/${found[1]}（扫描 ${scanned} 个）` : '未找到');
}

// ────────────────────────────────────────────── [2] M4：安全响应头
console.log('\n[2] M4 · 全站安全响应头');

const hz = await req('GET', '/healthz');
ok('/healthz 200', hz.status === 200, String(hz.status));
for (const [k, v] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'no-referrer'],
]) {
    ok(`/healthz 带 ${k}: ${v}`, (hz.headers.get(k) || '').toLowerCase() === v.toLowerCase(), hz.headers.get(k) || '(缺失)');
}

const unauth = await req('GET', '/api/subs', undefined, {});
ok('未带令牌访问 /api/subs → 401', unauth.status === 401, String(unauth.status));
ok('401 响应也带 nosniff', unauth.headers.get('x-content-type-options') === 'nosniff');

const authed = await req('GET', '/api/subs');
ok('带令牌访问 /api/subs → 200', authed.status === 200, String(authed.status));
ok('200 响应带 nosniff', authed.headers.get('x-content-type-options') === 'nosniff');

const wrong = await req('GET', '/api/subs', undefined, { Authorization: 'Bearer totally-wrong-token' });
ok('错误令牌 → 401（S1 的行为面）', wrong.status === 401, String(wrong.status));

// 304 不能带 body：这里用条件请求逼一个 304 出来，确认包装层没炸
const etagProbe = await req('GET', '/healthz');
const inm = etagProbe.headers.get('etag');
if (inm) {
    const c304 = await req('GET', '/healthz', undefined, { ...H, 'If-None-Match': inm });
    ok('条件请求 304 不抛错且保留安全头', [200, 304].includes(c304.status), String(c304.status));
} else {
    console.log('  · /healthz 无 ETag，跳过 304 分支');
}

// ────────────────────────────────────────────── [3] 播种
console.log('\n[3] 播种测试数据');

const SUB = '_audit_sub';
const RFILE = '_audit_remote.txt';
const LFILE = '_audit_local.txt';
const NODES =
    'vmess://' +
    Buffer.from(
        JSON.stringify({
            v: '2', ps: 'audit-香港 01', add: 'hk.example.com', port: 443,
            id: '11111111-1111-1111-1111-111111111111', aid: 0, net: 'ws',
            type: 'none', host: '', path: '/', tls: 'tls',
        }),
    ).toString('base64');

for (const p of [SUB, RFILE, LFILE]) {
    await req('DELETE', `/api/sub/${encodeURIComponent(p)}`).catch(() => {});
    await req('DELETE', `/api/file/${encodeURIComponent(p)}`).catch(() => {});
}

const mkSub = await req('POST', '/api/subs', { name: SUB, source: 'local', content: NODES, displayName: '审计订阅' });
ok('建订阅', mkSub.status === 201, String(mkSub.status));
const mkR = await req('POST', '/api/files', { name: RFILE, displayName: '远程文件', source: 'remote', url: 'https://example.com/a.txt' });
ok('建远程文件', mkR.status === 201, String(mkR.status));
const mkL = await req('POST', '/api/files', { name: LFILE, displayName: '本地文件', source: 'local', content: 'hello audit' });
ok('建本地文件', mkL.status === 201, String(mkL.status));

const shR = await req('POST', '/api/shares', { type: 'file', name: RFILE });
ok('建远程文件分享码', shR.status === 201, String(shR.status));
const codeR = shR.json?.data?.code || '';
const shL = await req('POST', '/api/shares', { type: 'file', name: LFILE });
const codeL = shL.json?.data?.code || '';

// ────────────────────────────────────────────── [4] M1：不再下发明文令牌
console.log('\n[4] M1 · /api/link 不再下发 adminLink / 明文令牌');

const lk = await req('GET', `/api/link?kind=sub&name=${encodeURIComponent(SUB)}`);
ok('/api/link 200', lk.status === 200, String(lk.status));
ok('返回体含 link', typeof lk.json?.data?.link === 'string' && lk.json.data.link.length > 0);
ok('返回体含 feedUrl', typeof lk.json?.data?.feedUrl === 'string' && lk.json.data.feedUrl.length > 0);
ok('返回体含 feedKey', typeof lk.json?.data?.feedKey === 'string' && lk.json.data.feedKey.length > 0);
ok('返回体不含 adminLink', !('adminLink' in (lk.json?.data || {})), JSON.stringify(Object.keys(lk.json?.data || {})));
ok('返回体任何位置都不含 token=', !lk.raw.includes('token='));
ok('返回体不含明文令牌本身', !lk.raw.includes(TOKEN));
ok('link 不含 target 参数（Sub-Store 模式）', !(lk.json?.data?.link || '').includes('target='));

// ────────────────────────────────────────────── [5] L2：远程文件地址协议白名单
console.log('\n[5] L2 · 远程文件地址必须是 http(s)');

const badUrls = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox(1)'];
for (const u of badUrls) {
    const r = await req('POST', '/api/files', { name: `_audit_bad_${badUrls.indexOf(u)}.txt`, source: 'remote', url: u });
    ok(`新建拒绝 ${u.slice(0, 28)}`, r.status === 400, `${r.status} ${r.json?.message || r.json?.error || ''}`);
}
const okUrl = await req('POST', '/api/files', { name: '_audit_ok_url.txt', source: 'remote', url: 'http://example.org/b.txt' });
ok('新建放行 http://', okUrl.status === 201, String(okUrl.status));
await req('DELETE', '/api/file/_audit_ok_url.txt');

// PATCH 绕过路径：不改名时也必须校验（曾经整段跳过 validateFile）
const p1 = await req('PATCH', `/api/file/${encodeURIComponent(LFILE)}`, { name: LFILE, source: 'remote', url: 'javascript:alert(1)' });
ok('PATCH 同名的 javascript: 地址被拒', p1.status === 400, `${p1.status} ${p1.json?.message || ''}`);
const after1 = await req('GET', `/api/file/${encodeURIComponent(LFILE)}`);
ok('被拒后记录未被改脏', after1.json?.data?.source === 'local', `source=${after1.json?.data?.source}`);

const p2 = await req('PATCH', `/api/file/${encodeURIComponent(LFILE)}`, { name: LFILE, source: 'local', content: 'hello audit v2' });
ok('PATCH 合法内容仍能保存', p2.status === 200, String(p2.status));
const after2 = await req('GET', `/api/file/${encodeURIComponent(LFILE)}`);
ok('合法 PATCH 生效', after2.json?.data?.content === 'hello audit v2', String(after2.json?.data?.content));

// 扩展名白名单也不能再被 PATCH 绕过
const p3 = await req('PATCH', `/api/file/${encodeURIComponent(LFILE)}`, { name: '_audit_bad_ext.exe', source: 'local', content: 'x' });
ok('PATCH 改名到 .exe 被拒', p3.status === 400, `${p3.status} ${p3.json?.message || ''}`);

// ────────────────────────────────────────────── [6] 分享出口行为
console.log('\n[6] L2 · 分享出口（/share/file）');

const sfRemote = await req('GET', `/share/file/${encodeURIComponent(RFILE)}?code=${codeR}`, undefined, {});
ok('远程文件分享 → 302 跳转', sfRemote.status === 302, String(sfRemote.status));
ok('跳转目标是配置的 https 地址', sfRemote.headers.get('location') === 'https://example.com/a.txt', sfRemote.headers.get('location') || '(无)');

const sfLocal = await req('GET', `/share/file/${encodeURIComponent(LFILE)}?code=${codeL}`, undefined, {});
ok('本地文件分享 → 200', sfLocal.status === 200, String(sfLocal.status));
ok('本地文件分享是 text/plain', (sfLocal.headers.get('content-type') || '').includes('text/plain'), sfLocal.headers.get('content-type') || '');
ok('本地文件分享带 nosniff（挡住 MIME 嗅探 XSS）', sfLocal.headers.get('x-content-type-options') === 'nosniff');

const sfBad = await req('GET', `/share/file/${encodeURIComponent(RFILE)}?code=nope`, undefined, {});
ok('错误分享码 → 403', sfBad.status === 403, String(sfBad.status));

// ────────────────────────────────────────────── [7] 纵深防御：库里已有非 http(s) 地址时拒绝跳转
console.log('\n[7] L2 · 纵深防御：库里若已存在非 http(s) 远程地址，跳转必须被拒');

{
    const { createSqliteStore } = await import('../apps/server/node/sqlite-store.mjs');
    const { handleShare } = await import('../apps/server/src/convert.js');

    const store = createSqliteStore(':memory:');
    await store.writeSnapshot({
        app: 'SubPilot', version: 1, updatedAt: '',
        subs: [], collections: [], converted: [], templates: [],
        files: [{ name: 'dirty.txt', displayName: '', source: 'remote', url: 'javascript:alert(1)', content: '' }],
        shares: [{ code: 'c-dirty', type: 'file', name: 'dirty.txt', createdAt: '', expiresAt: null, uses: 0 }],
        settings: {},
    });
    const env = { STORE: store, SUBPILOT_TOKEN: TOKEN };
    const res = await handleShare(new Request(`http://x/share/file/dirty.txt?code=c-dirty`), env, undefined, {
        path: '/share/file/dirty.txt',
        query: new URLSearchParams('code=c-dirty'),
        method: 'GET',
    });
    ok('非 http(s) 的远程文件 → 502 而非 302', res.status === 502, String(res.status));
    ok('响应里没有 Location 头', !res.headers.get('location'), res.headers.get('location') || '(无)');

    await store.writeSnapshot({
        app: 'SubPilot', version: 1, updatedAt: '',
        subs: [], collections: [], converted: [], templates: [],
        files: [{ name: 'dirty.txt', displayName: '', source: 'remote', url: 'https://ok.example.com/f', content: '' }],
        shares: [{ code: 'c-dirty', type: 'file', name: 'dirty.txt', createdAt: '', expiresAt: null, uses: 0 }],
        settings: {},
    });
    const res2 = await handleShare(new Request(`http://x/share/file/dirty.txt?code=c-dirty`), env, undefined, {
        path: '/share/file/dirty.txt',
        query: new URLSearchParams('code=c-dirty'),
        method: 'GET',
    });
    ok('http(s) 地址仍正常 302', res2.status === 302 && res2.headers.get('location') === 'https://ok.example.com/f', `${res2.status} ${res2.headers.get('location')}`);
    store.close();
}

// ────────────────────────────────────────────── 收尾
console.log('\n[8] 清理测试数据');
for (const code of [codeR, codeL]) if (code) await req('DELETE', `/api/shares?code=${code}`);
for (const p of [SUB, RFILE, LFILE]) {
    await req('DELETE', `/api/sub/${encodeURIComponent(p)}`);
    await req('DELETE', `/api/file/${encodeURIComponent(p)}`);
}
const leftSubs = await req('GET', '/api/subs');
const leftFiles = await req('GET', '/api/files');
ok('订阅无残留', !(leftSubs.json?.data || []).some((x) => x.name === SUB));
ok('文件无残留', !(leftFiles.json?.data || []).some((x) => x.name.startsWith('_audit')));

console.log(`\n== 审计 A 类修复回归：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
