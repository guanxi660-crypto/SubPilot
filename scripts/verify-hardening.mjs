// 加固回归（对应 AUDIT.md 的 M2 / M3 / M5 / L1 / L3 / L5 / L6）。
//
// 分三段：
//   · 单元段 —— 直接 import netguard.js / storage.js / ratelimit.js，
//     测字面校验、safeFetch 的**逐跳**校验、统计上限轮转、写冲突 CAS、
//     以及 mutate 的进程内串行化。这些没法从接口造出来。
//   · 本地服务段 —— 自己起一个 127.0.0.1 的 http 服务，专门造 302 链，
//     验证 safeFetch 在「第一跳放行、第二跳落到云元数据地址」时能拦住。
//     全部走回环，不出网。
//   · HTTP 段 —— 打真实本地服务，验 /sub 与 /api/preview/* 的取源守卫、
//     失败限流、订阅正文上限、来源 IP 不可伪造、设置导出导入对称、
//     AI baseUrl 覆盖被拒、并发写不丢。
//
// 用法：node scripts/verify-hardening.mjs [baseUrl]
// 需要先起本地服务：SUBPILOT_TOKEN=dev-local-token PORT=8795 node apps/server/node/server.mjs
//
// ⚠️ 限流用例会把 127.0.0.1 的 /ai 桶打到封禁，跑完必须用**正确令牌**清一次
// （正确令牌永远放行并清零计数 —— 这正是「不会把自己锁在门外」那条语义）。

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
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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

const {
    checkUrlSync,
    checkUrl,
    isPrivateIp,
    safeFetch,
    SsrfBlockedError,
} = await import('../apps/server/src/netguard.js');

// ══════════════════════════════════════════ [1] M2 · 字面校验
console.log('\n[1] M2 · SSRF 字面校验（协议 / 主机名 / 字面私网 IP / 内嵌凭据）');

// ⚠️ 下面凡是要验「主机名 / 私网 IP」的用例，都必须带上 allowHttp: true ——
// 否则 checkUrlSync 会先撞在协议检查上（"必须以 https:// 开头"），
// 断言照样通过，但**根本没验到**想验的那条规则。
const rejected = (url, opts, expect, note = '') => {
    const e = checkUrlSync(url, opts);
    const hit = !!e && (!expect || expect.test(e));
    ok(`拒绝 ${url}${note ? `（${note}）` : ''}`, hit, e || '(居然放行了)');
};
const good = (url, opts) => {
    const e = checkUrlSync(url, opts);
    ok(`放行 ${url}`, !e, e || '');
};

rejected('', undefined, /不能为空/, '空');
rejected('not a url', undefined, /格式不正确/, '格式');
rejected('ftp://example.com/x', undefined, /https/, '协议');
rejected('http://example.com/x', undefined, /https/, '默认只允许 https');
good('http://example.com/x', { allowHttp: true });
rejected('https://user:pass@example.com/x', undefined, /用户名/, '内嵌凭据');

const H1 = { allowHttp: true };
rejected('http://localhost/', H1, /云元数据|本机别名/, '本机别名');
rejected('http://metadata.google.internal/', H1, /云元数据|本机别名/, '云元数据');
rejected('http://metadata.goog/', H1, /云元数据|本机别名/, 'GCP 元数据别名');
rejected('http://instance-data/', H1, /云元数据|本机别名/, 'AWS 老别名');
rejected('http://169.254.169.254/latest/meta-data/', H1, /云元数据|本机别名/, 'AWS 元数据 IP');
rejected('http://169.254.170.2/v2/credentials', H1, /云元数据|本机别名/, 'ECS 任务元数据');
rejected('http://100.100.100.200/latest/meta-data/', H1, /云元数据|本机别名/, '阿里云元数据');
rejected('http://foo.internal/', H1, /内网域名/, '.internal 后缀');
rejected('http://nas.local/', H1, /内网域名/, '.local 后缀');
rejected('http://box.home.arpa/', H1, /内网域名/, '.home.arpa 后缀');

for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.5', '0.0.0.0']) {
    rejected(`http://${ip}/`, H1, /内网 \/ 环回 \/ 保留/, '字面私网 / 保留');
}
// WHATWG URL 会把这些混淆写法**归一化**成 127.0.0.1，所以下面每条都必须被拦
for (const [u, norm] of [
    ['http://2130706433/', '127.0.0.1'],
    ['http://0x7f000001/', '127.0.0.1'],
    ['http://0177.0.0.1/', '127.0.0.1'],
    ['http://127.1/', '127.0.0.1'],
]) {
    rejected(u, H1, /内网 \/ 环回 \/ 保留/, `十进制 / 十六进制 / 八进制 / 短写 → ${norm}`);
}
ok('URL 归一化确实把 2130706433 变成 127.0.0.1（测试前提）', new URL('http://2130706433/').hostname === '127.0.0.1', new URL('http://2130706433/').hostname);

for (const u of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::]/']) {
    rejected(u, H1, /内网 \/ 环回 \/ 保留/, 'IPv6 环回 / 唯一本地 / 链路本地');
}

good('https://example.com/x');
good('https://1.1.1.1/dns-query');
good('https://[2606:4700:4700::1111]/dns-query');
good('http://10.0.0.1/x', { allowHttp: true, allowPrivate: true }, '逃生开关放行私网');

// 私网判定函数本身
for (const [ip, want] of [
    ['127.0.0.1', true], ['8.8.8.8', false], ['0.0.0.0', true], ['255.255.255.255', true],
    ['224.0.0.1', true], ['198.18.0.1', true], ['198.19.255.254', true], ['192.0.2.1', true],
    ['203.0.113.5', true], ['256.1.1.1', false], ['::1', true], ['::ffff:7f00:1', true],
    ['2001:db8::1', true], ['2606:4700::1111', false],
]) {
    ok(`isPrivateIp(${ip}) === ${want}`, isPrivateIp(ip) === want, String(isPrivateIp(ip)));
}

// ────────────────────────────── DNS 复核（注入解析器，不出网）
console.log('\n  · DNS 复核（注入解析器）');
const resolveTo = (list) => async () => list;
ok('解析到私网 → 拦', (await checkUrl('https://evil.example.com/', { resolve: resolveTo(['10.0.0.5']) })).includes('DNS rebinding'));
ok('解析到环回 → 拦', !!(await checkUrl('https://evil.example.com/', { resolve: resolveTo(['127.0.0.1']) })));
ok('解析到公网 → 放行', (await checkUrl('https://ok.example.com/', { resolve: resolveTo(['93.184.216.34']) })) === '');
// fake-IP：Clash / mihomo 的 TUN 模式把**所有**域名解析到 198.18.0.0/15 占位地址。
// 不放过它的话，这类部署（国内极常见）会把每一个域名都判成 DNS rebinding，
// 等于把出网功能整个打死。
ok('解析到 fake-IP（198.18/15）→ 放行', (await checkUrl('https://ok.example.com/', { resolve: resolveTo(['198.18.14.153']) })) === '');
ok('fake-IP 与真实私网混合 → 仍拦', !!(await checkUrl('https://ok.example.com/', { resolve: resolveTo(['198.18.14.153', '10.0.0.5']) })));
ok('解析抛错 → 明确报「解析失败」', (await checkUrl('https://ok.example.com/', { resolve: async () => { throw new Error('ENOTFOUND'); } })).includes('解析失败'));
ok('解析为空数组 → 明确报「解析不到地址」', (await checkUrl('https://ok.example.com/', { resolve: resolveTo([]) })).includes('解析不到地址'));
ok('字面 IP 不触发解析（解析器抛错也放行）', (await checkUrl('https://1.1.1.1/', { resolve: async () => { throw new Error('不该被调用'); } })) === '');
ok('allowPrivate 时不查 DNS', (await checkUrl('https://ok.example.com/', { allowPrivate: true, resolve: resolveTo(['10.0.0.5']) })) === '');

// ══════════════════════════════════════════ [2] M2 · safeFetch 逐跳校验
console.log('\n[2] M2 · safeFetch 自己跟随重定向并逐跳复检（本地 302 链，不出网）');

const { createServer } = await import('node:http');
const hopServer = createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://127.0.0.1');
    const route = u.pathname;
    if (route === '/ok') {
        rs.writeHead(200, { 'content-type': 'text/plain' });
        rs.end('OK-BODY');
    } else if (route === '/echo-method') {
        rs.writeHead(200, { 'content-type': 'text/plain' });
        rs.end(rq.method);
    } else if (route === '/to-meta') {
        rs.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        rs.end();
    } else if (route === '/to-ok') {
        rs.writeHead(302, { location: '/ok' });
        rs.end();
    } else if (route === '/to-echo-303') {
        rs.writeHead(303, { location: '/echo-method' });
        rs.end();
    } else if (route === '/to-echo-307') {
        rs.writeHead(307, { location: '/echo-method' });
        rs.end();
    } else if (route === '/loop') {
        rs.writeHead(302, { location: '/loop' });
        rs.end();
    } else {
        rs.writeHead(404);
        rs.end('nope');
    }
});
await new Promise((r) => hopServer.listen(0, '127.0.0.1', r));
const HOP = `http://127.0.0.1:${hopServer.address().port}`;
const localOpts = { allowHttp: true, allowPrivate: true };

{
    const r = await safeFetch(`${HOP}/ok`, {}, localOpts);
    ok('直连 200 正常返回', r.status === 200 && (await r.text()) === 'OK-BODY', `HTTP ${r.status}`);

    const r2 = await safeFetch(`${HOP}/to-ok`, {}, localOpts);
    ok('跟随 302 → 最终 200', r2.status === 200, `HTTP ${r2.status}`);
    ok('跟随后的最终地址是重定向目标', r2.url === `${HOP}/ok`, r2.url);

    let blocked = null;
    try {
        await safeFetch(`${HOP}/to-meta`, {}, localOpts);
    } catch (e) {
        blocked = e;
    }
    ok('第一跳放行、第二跳落到 169.254.169.254 → 抛 SsrfBlockedError', blocked instanceof SsrfBlockedError, blocked ? `${blocked.code}` : '居然请求成功了');
    ok('错误信息能说清拦在哪', !!blocked && /元数据|内网|环回|保留/.test(blocked.message), blocked?.message || '');

    // 只放开协议、不放开私网：第一跳就该因为 127.0.0.1 被拦
    // （证明「守卫生效」而不是「碰巧第二跳才拦」）
    let first = null;
    try {
        await safeFetch(`${HOP}/to-ok`, {}, { allowHttp: true });
    } catch (e) {
        first = e;
    }
    ok('未开逃生开关时第一跳即被拦', first instanceof SsrfBlockedError && /内网/.test(first.message), first?.message || '');

    let looped = null;
    try {
        await safeFetch(`${HOP}/loop`, {}, localOpts);
    } catch (e) {
        looped = e;
    }
    ok('无限重定向 → 超过上限后抛错', looped instanceof SsrfBlockedError && /次数/.test(looped.message), looped?.message || '');

    const r303 = await safeFetch(`${HOP}/to-echo-303`, { method: 'POST', body: 'x' }, localOpts);
    ok('303 → 重定向后改 GET', (await r303.text()) === 'GET');
    const r307 = await safeFetch(`${HOP}/to-echo-307`, { method: 'POST', body: 'x' }, localOpts);
    ok('307 → 重定向后保留 POST', (await r307.text()) === 'POST');

    ok('SsrfBlockedError 带 expose 标记（入口会翻成 400 而非 500）', blocked?.expose === true && blocked?.status === 400);
}

// ══════════════════════════════════════════ [3] M2 · HTTP 取源被拦
console.log('\n[3] M2 · HTTP 接口的取源守卫');

const subBlocked = await req('GET', `/sub?target=clash&url=${encodeURIComponent('http://127.0.0.1:8795/healthz')}`);
ok('/sub?url=127.0.0.1 → 400', subBlocked.status === 400, `${subBlocked.status} ${subBlocked.json?.message || ''}`);
ok('/sub 的拒绝理由指向内网地址', /内网|环回|保留/.test(subBlocked.json?.message || ''), subBlocked.json?.message || '');

const subMeta = await req('GET', `/sub?target=clash&url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
ok('/sub?url=云元数据 → 400', subMeta.status === 400, `${subMeta.status} ${subMeta.json?.message || ''}`);

const pvSub = await req('POST', '/api/preview/sub', { name: 'x', source: 'remote', url: 'http://169.254.169.254/latest/meta-data/' });
ok('/api/preview/sub 私网地址 → 400', pvSub.status === 400, `${pvSub.status} ${pvSub.json?.message || ''}`);

const pvProc = await req('POST', '/api/preview/process', { url: 'http://127.0.0.1:8795/healthz' });
ok('/api/preview/process 私网地址 → 400', pvProc.status === 400, `${pvProc.status} ${pvProc.json?.message || ''}`);

// 正对照：公网地址不能被守卫误拦（错误信息里不该出现守卫的措辞）
const pvPub = await req('POST', '/api/preview/process', { url: 'https://example.com/not-exist' });
ok('公网地址不被守卫误拦（错误来自网络层而非守卫）', !/内网|环回|保留地址|不允许访问/.test(pvPub.json?.message || ''), `${pvPub.status} ${(pvPub.json?.message || '').slice(0, 60)}`);

// ══════════════════════════════════════════ [4] M3 · 失败限流
console.log('\n[4] M3 · 令牌校验失败限流');

const { RATE_LIMIT_CONFIG } = await import('../apps/server/src/ratelimit.js');
ok('限流参数：5 分钟窗口 / 20 次失败 / 封禁 15 分钟', RATE_LIMIT_CONFIG.MAX_FAILURES === 20 && RATE_LIMIT_CONFIG.BLOCK_MS === 15 * 60 * 1000, JSON.stringify(RATE_LIMIT_CONFIG));

// 先用正确令牌清一次 /ai 桶，保证起点干净
await req('GET', '/ai/presets');
let firstBlockAt = 0;
let blocked429 = 0;
for (let i = 1; i <= RATE_LIMIT_CONFIG.MAX_FAILURES + 3; i++) {
    const r = await req('GET', '/ai/presets', undefined, { Authorization: `Bearer wrong-${i}` });
    if (r.status === 429) {
        blocked429 += 1;
        if (!firstBlockAt) firstBlockAt = i;
    } else {
        ok(`第 ${i} 次错误令牌 → 401`, r.status === 401, String(r.status));
    }
    if (i > RATE_LIMIT_CONFIG.MAX_FAILURES + 3) break;
}
ok('达到阈值后开始返回 429', firstBlockAt === RATE_LIMIT_CONFIG.MAX_FAILURES, `第 ${firstBlockAt} 次开始 429`);
ok('封禁期内持续 429', blocked429 >= 3, `${blocked429} 次`);

const rl429 = await req('GET', '/ai/presets', undefined, { Authorization: 'Bearer wrong-again' });
ok('429 带 Retry-After 头', Number(rl429.headers.get('retry-after')) > 0, rl429.headers.get('retry-after') || '(缺失)');
ok('429 文案说明是限流而非令牌错', /次数过多/.test(rl429.json?.message || ''), rl429.json?.message || '');

// 关键语义：**正确令牌永远放行**，不会被自己锁在门外
const okDuringBlock = await req('GET', '/ai/presets');
ok('封禁期内正确令牌仍放行（不会自己锁死自己）', okDuringBlock.status === 200, String(okDuringBlock.status));
const afterClear = await req('GET', '/ai/presets', undefined, { Authorization: 'Bearer still-wrong' });
ok('成功一次即清零计数（立刻回到 401 而非 429）', afterClear.status === 401, String(afterClear.status));

// ══════════════════════════════════════════ [5] M5 · 订阅正文上限
console.log('\n[5] M5 · 本地订阅正文上限（8MiB）');

const SMALL = '_audit_size_sub';
const BIG = '_audit_big_sub';
await req('DELETE', `/api/sub/${encodeURIComponent(SMALL)}`);
await req('DELETE', `/api/sub/${encodeURIComponent(BIG)}`);

const mk = await req('POST', '/api/subs', { name: SMALL, source: 'local', content: 'ss://abc@1.2.3.4:8388#A' });
ok('建一条正常订阅', mk.status === 201, String(mk.status));

const bigBody = 'a'.repeat(9 * 1024 * 1024);
const over = await req('POST', '/api/subs', { name: BIG, source: 'local', content: bigBody });
ok('POST 9MiB 正文 → 413（不是 500）', over.status === 413, `${over.status} ${over.json?.message || ''}`);
ok('拒绝文案说明上限与当前体积', /8MiB/.test(over.json?.message || ''), over.json?.message || '');

const overPatch = await req('PATCH', `/api/sub/${encodeURIComponent(SMALL)}`, { content: bigBody });
ok('PATCH 塞 9MiB → 413', overPatch.status === 413, `${overPatch.status} ${overPatch.json?.message || ''}`);
const afterPatch = await req('GET', `/api/sub/${encodeURIComponent(SMALL)}`);
ok('被拒后原记录未被改脏', afterPatch.json?.data?.content === 'ss://abc@1.2.3.4:8388#A', String(afterPatch.json?.data?.content).slice(0, 40));

// 正对照：1MiB 应当放行（证明不是「一律拒绝大内容」）
const okBig = await req('POST', '/api/subs', { name: BIG, source: 'local', content: 'b'.repeat(1024 * 1024) });
ok('1MiB 正文仍放行', okBig.status === 201, String(okBig.status));
await req('DELETE', `/api/sub/${encodeURIComponent(BIG)}`);

// 备份导入路径也必须挡（此前它完全绕过校验）
const impBig = await req('POST', '/api/backup/import', {
    app: 'SubPilot',
    subs: [{ name: BIG, source: 'local', content: bigBody }],
});
ok('备份导入含超限订阅 → 被跳过并给出 warning', (impBig.json?.data?.skipped || 0) >= 1 && /8MiB/.test(JSON.stringify(impBig.json?.data?.warnings || [])), JSON.stringify(impBig.json?.data?.warnings || []).slice(0, 140));
const impLeft = await req('GET', '/api/subs');
ok('超限订阅没有被写进库', !(impLeft.json?.data || []).some((x) => x.name === BIG));

// 导入路径也要和写入路径同语义：远程订阅不存正文
const IMPR = '_audit_remote_imp';
await req('DELETE', `/api/sub/${encodeURIComponent(IMPR)}`);
await req('POST', '/api/backup/import', {
    app: 'SubPilot',
    subs: [{ name: IMPR, source: 'remote', url: 'https://example.com/a.txt', content: 'LEAKED-BODY' }],
});
const gotImpr = await req('GET', `/api/sub/${encodeURIComponent(IMPR)}`);
ok('导入的远程订阅不携带正文（与 normalizeSub 同语义）', gotImpr.json?.data?.content === '', JSON.stringify(gotImpr.json?.data?.content ?? '(记录不存在)'));

// ══════════════════════════════════════════ [6] M5 · 统计上限与轮转
console.log('\n[6] M5 · 统计条目上限与轮转（单元）');

{
    const { createSqliteStore } = await import('../apps/server/node/sqlite-store.mjs');
    const { recordPull, loadStats, MAX_STATS_ITEMS } = await import('../apps/server/src/storage.js');

    ok('条目上限常量 = 5000', MAX_STATS_ITEMS === 5000, String(MAX_STATS_ITEMS));

    const store = createSqliteStore(':memory:');
    const env = { STORE: store };

    // 低于上限：同 key 累加
    await recordPull(env, { type: 'sub', item: 'a', ip: '1.1.1.1' });
    const twice = await recordPull(env, { type: 'sub', item: 'a', ip: '1.1.1.1' });
    ok('同 key 累加计数', twice.count === 2, String(twice.count));

    // 铺满到上限：last 递增，方便断言「淘汰的是最旧的」
    const base = Date.parse('2020-01-01T00:00:00.000Z');
    const items = {};
    for (let i = 0; i < MAX_STATS_ITEMS; i++) {
        items[`seed|${i}|10.0.0.${i % 256}`] = {
            type: 'seed',
            item: String(i),
            ip: `10.0.0.${i % 256}`,
            count: 1,
            last: new Date(base + i * 1000).toISOString(),
        };
    }
    await store.writeStats({ items });

    const before = await loadStats(env);
    ok('铺满到上限后条目数 = 5000', Object.keys(before.items).length === MAX_STATS_ITEMS, String(Object.keys(before.items).length));

    await recordPull(env, { type: 'sub', item: 'fresh', ip: '9.9.9.9' });
    const after = await loadStats(env);
    const keys = Object.keys(after.items);
    ok('超限后一次淘汰到低水位（4500）', keys.length === 4500, String(keys.length));
    ok('淘汰数被累计到 dropped（可见化）', after.dropped === 501, String(after.dropped));
    const seedKey = (i) => `seed|${i}|10.0.0.${i % 256}`;
    ok('最旧的被淘汰', !keys.includes(seedKey(0)), keys.includes(seedKey(0)) ? '居然还在' : '');
    ok('第 500 条也被淘汰（一次淘汰 501 条）', !keys.includes(seedKey(500)), '');
    ok('第 501 条是保留区间的第一条', keys.includes(seedKey(501)), '');
    ok('最新的种子记录被保留', keys.includes(seedKey(MAX_STATS_ITEMS - 1)), '');
    ok('新写入的那条一定保留（last 最新）', keys.includes('sub|fresh|9.9.9.9'), '');
    ok('统计体积未无限增长（key 数 ≤ 上限）', keys.length <= MAX_STATS_ITEMS, String(keys.length));

    store.close();

    // 写入失败：不能静默
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.map(String).join(' '));
    let threw = false;
    try {
        await recordPull(
            {
                STORE: {
                    readSnapshot: async () => null,
                    writeSnapshot: async () => {},
                    readStats: async () => ({ items: {} }),
                    writeStats: async () => {
                        throw new Error('KV write failed');
                    },
                },
            },
            { type: 'sub', item: 'x', ip: '1.2.3.4' },
        );
    } catch {
        threw = true;
    } finally {
        console.warn = origWarn;
    }
    ok('统计写失败仍抛给调用方（waitUntil 照旧兜住，不影响分发）', threw);
    ok('统计写失败留下 warn 日志（不再完全静默）', warns.some((w) => w.includes('写入失败')), warns.join(' | ').slice(0, 80));
}

// ══════════════════════════════════════════ [7] L1 · 来源 IP 不可伪造
console.log('\n[7] L1 · 来源 IP 不可伪造');

const L1SUB = '_audit_ip_sub';
await req('DELETE', `/api/sub/${encodeURIComponent(L1SUB)}`);
await req('POST', '/api/subs', { name: L1SUB, source: 'local', content: 'ss://abc@1.2.3.4:8388#A' });
const link = await req('GET', `/api/link?kind=sub&name=${encodeURIComponent(L1SUB)}`);
const feedKey = link.json?.data?.feedKey || '';
ok('拿到分发密钥', !!feedKey, feedKey ? `${feedKey.length} 位` : '');

await req('GET', `/download/${encodeURIComponent(L1SUB)}?ft=${feedKey}`, undefined, {
    'CF-Connecting-IP': '1.2.3.4',
    'X-Real-IP': '5.6.7.8',
    'X-Forwarded-For': '9.9.9.9',
});
await new Promise((r) => setTimeout(r, 400)); // recordPull 走 waitUntil，等它落地

const stats = await req('GET', '/api/stats');
const mine = (stats.json?.data?.items || []).filter((x) => x.item === L1SUB);
ok('分发统计里出现该订阅的记录', mine.length > 0, `${mine.length} 条`);
const ips = mine.map((x) => x.ip);
ok('伪造的 CF-Connecting-IP 未被采信', !ips.includes('1.2.3.4'), ips.join(',') || '(无)');
ok('伪造的 X-Real-IP 未被采信', !ips.includes('5.6.7.8'), '');
ok('伪造的 X-Forwarded-For 未被采信', !ips.includes('9.9.9.9'), '');
ok('记录的是真实对端地址（回环）', ips.every((ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'), ips.join(',') || '(无)');
ok('/api/stats 暴露条目上限（让上限可感知）', stats.json?.data?.limit === 5000, String(stats.json?.data?.limit));
ok('/api/stats 暴露当前条目数', typeof stats.json?.data?.entries === 'number', String(stats.json?.data?.entries));
ok('/api/stats 暴露被淘汰数', typeof stats.json?.data?.dropped === 'number', String(stats.json?.data?.dropped));

// ══════════════════════════════════════════ [8] L3 · 设置导出 / 导入对称
console.log('\n[8] L3 · 设置导出 / 导入对称');

const exp = await req('GET', '/api/backup/export');
const es = exp.json?.data?.settings || {};
ok('导出体带 settings', !!es && typeof es === 'object', Object.keys(es).join(','));
for (const k of ['subBackend', 'publicBaseUrl', 'defaultTarget', 'defaultConfig']) {
    ok(`导出 settings 含 ${k}`, k in es);
}
ok('导出 settings.ai 含 baseUrl / model', 'baseUrl' in (es.ai || {}) && 'model' in (es.ai || {}));
ok('导出 settings.sync 含 provider / gistId / webdav.url', !!es.sync?.provider && 'gistId' in (es.sync?.gist || {}) && 'url' in (es.sync?.webdav || {}));
ok('导出 settings.telegram 含 chatIds / targets / linkType / autoPush', 'chatIds' in (es.telegram || {}) && 'targets' in (es.telegram || {}) && 'linkType' in (es.telegram || {}) && 'autoPush' in (es.telegram || {}));
// 凭据一律不进备份
const raw = exp.raw;
ok('导出体不含 apiKey 字段', !/"apiKey"\s*:/.test(raw));
ok('导出体不含 feedSalt', !raw.includes('feedSalt'));
ok('导出体不含 webdav pass', !/"pass"\s*:/.test(raw));
ok('导出体不含任何 *Mask（那是给前端看的，不是备份）', !raw.includes('apiKeyMask') && !raw.includes('tokenMask') && !raw.includes('passMask'));

// 凭据标记基线
const before = (await req('GET', '/api/settings')).json?.data || {};
const marks = (d) => [d.ai?.hasApiKey, d.sync?.gist?.hasToken, d.sync?.webdav?.hasPass, d.telegram?.tokenSet].map(Boolean).join(',');
const beforeMarks = marks(before);
const beforeVals = {
    subBackend: before.subBackend || '',
    defaultTarget: before.defaultTarget || '',
    publicBaseUrl: before.publicBaseUrl || '',
    aiBaseUrl: before.ai?.baseUrl || '',
    aiModel: before.ai?.model || '',
    tgChatIds: before.telegram?.chatIds || '',
};

// 导入一份带「非凭据新值 + 凭据诱饵」的备份
const imported = {
    subBackend: 'https://imported-backend.example.com/sub',
    publicBaseUrl: 'https://imported.example.com',
    defaultTarget: 'singbox',
    defaultConfig: '',
    ai: { baseUrl: 'https://imported-ai.example.com/v1', model: 'imported-model', apiKey: 'LEAK_API_KEY' },
    sync: { provider: 'none', gist: { gistId: '', token: 'LEAK_GIST_TOKEN' }, webdav: { url: '', user: '', dir: '', pass: 'LEAK_PASS' } },
    telegram: { chatIds: '111,222', targets: [{ kind: 'sub', name: L1SUB }, { kind: 'bogus', name: 'x' }], linkType: '', autoPush: false, token: 'LEAK_BOT_TOKEN' },
};
const imp = await req('POST', '/api/backup/import', { app: 'SubPilot', settings: imported });
ok('导入返回 settingsUpdated 计数', (imp.json?.data?.settingsUpdated || 0) > 0, String(imp.json?.data?.settingsUpdated));

const after = (await req('GET', '/api/settings')).json?.data || {};
ok('转换后端已从备份恢复', after.subBackend === imported.subBackend, after.subBackend);
ok('公开地址已从备份恢复', after.publicBaseUrl === imported.publicBaseUrl, after.publicBaseUrl);
ok('默认 target 已从备份恢复', after.defaultTarget === imported.defaultTarget, after.defaultTarget);
ok('AI baseUrl / model 已从备份恢复', after.ai?.baseUrl === imported.ai.baseUrl && after.ai?.model === imported.ai.model, `${after.ai?.baseUrl} / ${after.ai?.model}`);
ok('TG chatIds 已从备份恢复', after.telegram?.chatIds === imported.telegram.chatIds, after.telegram?.chatIds);
ok('TG targets 已恢复且脏 kind 被过滤', (after.telegram?.targets || []).length === 1 && after.telegram.targets[0].name === L1SUB, JSON.stringify(after.telegram?.targets || []));
ok('凭据标记完全不变（备份里的 LEAK_* 未生效）', marks(after) === beforeMarks, `${beforeMarks} → ${marks(after)}`);

// 还原
await req('POST', '/api/settings', {
    subBackend: beforeVals.subBackend,
    publicBaseUrl: beforeVals.publicBaseUrl,
    defaultTarget: beforeVals.defaultTarget,
    ai: { baseUrl: beforeVals.aiBaseUrl, model: beforeVals.aiModel },
    telegram: { chatIds: beforeVals.tgChatIds },
});
const restored = (await req('GET', '/api/settings')).json?.data || {};
ok('收尾：设置已还原', restored.subBackend === beforeVals.subBackend && restored.defaultTarget === beforeVals.defaultTarget, `${restored.subBackend} / ${restored.defaultTarget}`);

// ══════════════════════════════════════════ [9] L5 · AI baseUrl 覆盖被拦
console.log('\n[9] L5 · AI 接口的 baseUrl 覆盖必须过守卫');

// ⚠️ handleAiTest 会先要求 model 非空（缺啥报啥），所以 model 必须一起给，
// 否则请求在到达守卫之前就被挡下，断言看着通过、其实没验到守卫。
for (const [path, name] of [['/ai/models', 'handleAiModels'], ['/ai/settings/test', 'handleAiSettingsTest']]) {
    const r = await req('POST', path, { baseUrl: 'http://127.0.0.1:8795/healthz', model: 'probe-model' });
    ok(`${name}：覆盖到私网地址 → 400`, r.status === 400, `${r.status} ${r.json?.message || ''}`);
    ok(`${name}：拒绝理由指向内网（而不是别的校验）`, /内网|环回|保留/.test(r.json?.message || ''), (r.json?.message || '').slice(0, 60));
}
const aiMeta = await req('POST', '/ai/models', { baseUrl: 'http://169.254.169.254/latest/meta-data/' });
ok('AI baseUrl 覆盖到云元数据 → 400', aiMeta.status === 400, `${aiMeta.status} ${aiMeta.json?.message || ''}`);

// ══════════════════════════════════════════ [10] L6 · 并发写不丢
console.log('\n[10] L6 · 并发写一致性');

{
    const { createSqliteStore } = await import('../apps/server/node/sqlite-store.mjs');
    const { mutate, loadSnapshot, ConflictError } = await import('../apps/server/src/storage.js');

    const store = createSqliteStore(':memory:');
    const env = { STORE: store };
    await store.writeSnapshot({ app: 'SubPilot', version: 1, rev: 0, updatedAt: '', subs: [], collections: [], files: [], converted: [], shares: [], templates: [], settings: {} });

    // 乐观锁：拿旧 rev 去写必须被拒
    let conflict = null;
    try {
        await store.writeSnapshot({ app: 'SubPilot', version: 1, rev: 1, updatedAt: '', subs: [], collections: [], files: [], converted: [], shares: [], templates: [], settings: {} }, { expectedRev: 99 });
    } catch (e) {
        conflict = e;
    }
    ok('旧 rev 写入 → ConflictError', conflict instanceof ConflictError, conflict?.message || '居然写进去了');
    ok('ConflictError 带 409（入口会翻成 409 而非 500）', conflict?.status === 409 && conflict?.expose === true);
    const snapNow = await loadSnapshot(env);
    ok('冲突时库内 rev 未被推进', snapNow.rev === 0, String(snapNow.rev));

    // 进程内串行化：20 个并发 mutate 必须一条不丢
    await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
            mutate(env, (s) => {
                s.files.push({ name: `f${i}`, displayName: '', source: 'local', url: '', content: `v${i}`, createdAt: '', updatedAt: '' });
            }),
        ),
    );
    const after = await loadSnapshot(env);
    ok('20 个并发 mutate 一条不丢（进程内串行化）', after.files.length === 20, `落库 ${after.files.length} 条`);
    ok('rev 随写次数递增', after.rev >= 20, String(after.rev));
    ok('每条的内容都是自己的（没有互相覆盖）', after.files.every((f) => f.content === `v${f.name.slice(1)}`), after.files.map((f) => f.content).join(','));

    store.close();
}

// HTTP 层并发：8 个同时新建订阅，必须全部存在
const CC = Array.from({ length: 8 }, (_, i) => `_audit_cc_${i}`);
for (const n of CC) await req('DELETE', `/api/sub/${encodeURIComponent(n)}`);
await Promise.all(CC.map((n) => req('POST', '/api/subs', { name: n, source: 'local', content: 'ss://abc@1.2.3.4:8388#A' })));
const listAfter = await req('GET', '/api/subs');
const got = (listAfter.json?.data || []).filter((x) => x.name.startsWith('_audit_cc_')).length;
ok('8 个并发 POST /api/subs 全部落库', got === 8, `落库 ${got} / 8`);

// ══════════════════════════════════════════ 收尾
console.log('\n[11] 清理测试数据');
for (const n of [...CC, SMALL, BIG, L1SUB, IMPR]) {
    await req('DELETE', `/api/sub/${encodeURIComponent(n)}`);
}
const left = await req('GET', '/api/subs');
ok('订阅无残留', !(left.json?.data || []).some((x) => x.name.startsWith('_audit_')));
ok('限流桶已清（正确令牌放行）', (await req('GET', '/ai/presets')).status === 200);

await new Promise((r) => hopServer.close(r));

console.log(`\n== 加固回归（M2/M3/M5/L1/L3/L5/L6）：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
