// 转换页「成品链接」（GET /api/convert-link）回归。
//
// 需求（用户 2026-10-10）：转换板块产出的那条链接 —— 也就是成品链接 ——
// 要**保留为后端的格式**：`<转换后端>/sub?target=…&url=…&config=…`，
// 其中 `<转换后端>` 就是这次转换实际会打到的那台（部署默认或设置里自定义的，
// 后端是哪台就用哪台），不重写成 SubPilot 自己的 /download、/share 形态。
//
// 这里要钉死的几件事：
//   · 链接里的参数与真正转换时发给后端的一模一样（两边共用 prepareConversion，
//     所以「链接能跑通」等价于「转换能跑通」）—— 断言里直接把 url= 指向的
//     feed 地址拉一次，200 才算数；
//   · host 跟随设置里的自定义后端；
//   · 管理令牌绝不进链接；
//   · target=raw / 缺来源 / 订阅不存在 各自给对的状态码。
//
// 用法：node scripts/verify-convert-link.mjs [baseUrl]
// 自带播种与收尾清理，不留垃圾数据。

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
    if (c) {
        pass += 1;
        console.log(`  ✓ ${n}${extra ? ` — ${extra}` : ''}`);
    } else {
        fail += 1;
        console.log(`  ✗ ${n}${extra ? ` — ${extra}` : ''}`);
    }
};

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

const NODES = (tag) =>
    [
        { ps: `${tag}-香港 01`, add: 'hk.example.com' },
        { ps: `${tag}-日本 01`, add: 'jp.example.com' },
    ]
        .map((n) =>
            'vmess://' +
            Buffer.from(
                JSON.stringify({
                    v: '2', ps: n.ps, add: n.add, port: 443,
                    id: '11111111-1111-1111-1111-111111111111',
                    aid: 0, net: 'ws', type: 'none', host: '', path: '/', tls: 'tls',
                }),
            ).toString('base64'),
        )
        .join('\n');

/** 取一条成品链接。返回 { status, data } */
async function linkOf(params, { token = TOKEN } = {}) {
    const q = new URLSearchParams(params);
    if (token) q.set('token', token);
    const r = await fetch(`${BASE}/api/convert-link?${q}`);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: j.data || {} };
}

console.log(`\n== 转换页成品链接（后端格式）回归 @ ${BASE} ==\n`);

// ---- 播种 ----
const A = '_vt_clink_a';
const B = '_vt_clink_b';
for (const [name, content] of [
    [A, NODES('A')],
    [B, NODES('B')],
]) {
    const r = await fetch(`${BASE}/api/subs`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name, source: 'local', content }),
    });
    ok(`播种 ${name}`, r.status === 201 || r.status === 200, `HTTP ${r.status}`);
}

// 拿一次后端基地址（后面所有断言都按它比）
const envRes = await (await fetch(`${BASE}/api/utils/env`, { headers: H })).json();
const backend = envRes.data?.subBackend || '';
ok('能读到有效转换后端', /^https?:\/\//.test(backend), backend || '(空)');

// ---- [1] 鉴权与错误码 ----
{
    const noToken = await linkOf({ sub: A, target: 'clash' }, { token: '' });
    ok('不带令牌 → 401', noToken.status === 401, `HTTP ${noToken.status}`);

    const noSource = await linkOf({ target: 'clash' });
    ok('缺来源 → 400', noSource.status === 400, `HTTP ${noSource.status}`);

    const missing = await linkOf({ sub: '_vt_not_exist', target: 'clash' });
    ok('订阅不存在 → 404', missing.status === 404, `HTTP ${missing.status}`);

    const raw = await linkOf({ sub: A, target: 'raw' });
    ok('target=raw → 400（raw 不经过转换后端）', raw.status === 400, `HTTP ${raw.status}`);
}

// ---- [2] 单个本站订阅：host 是后端、url 指向本站 feed ----
const one = await linkOf({ sub: A, target: 'clash' });
const oneUrl = one.data.url || '';
ok('单订阅返回链接', one.status === 200 && !!oneUrl, `HTTP ${one.status}`);
ok('链接 host = 转换后端', oneUrl.startsWith(`${backend}/sub?`), oneUrl.slice(0, 70) + '…');
ok('data.backend 与链接 host 一致', one.data.backend === backend, one.data.backend || '(空)');
ok('走的是本地处理路径（local=true）', one.data.local === true, String(one.data.local));

let oneQ = null;
try {
    oneQ = new URL(oneUrl).searchParams;
} catch {
    /* 下面几条断言会因为 oneQ 为 null 而失败，报错信息足够定位 */
}
ok('target 参数保留', oneQ?.get('target') === 'clash', oneQ?.get('target') || '(无)');
ok(
    'url= 指向本站 /feed（后端能拉到的形态）',
    new RegExp(`^tag:.+,provider:.+,${BASE}/feed/sub/${A}\\?ft=`).test(oneQ?.get('url') || ''),
    (oneQ?.get('url') || '').replace(BASE, '') .slice(0, 90) + '…',
);
ok('clash 目标带 tag:/provider: 前缀', /^tag:[^,]+,provider:[^,]+,/.test(oneQ?.get('url') || ''));
ok('链接不含管理令牌', !/[?&]token=/.test(oneUrl) && !oneUrl.includes(TOKEN));
ok('链接不含内部参数（sub=）', !oneQ?.has('sub') && !oneQ?.has('collection'));

// ---- [3] 链接是「活的」：url= 里那条 feed 直接拉一次 ----
// 这条是本脚本的核心断言：链接里的参数就是真正转换时发给后端的参数，
// 所以它必须能拉通 —— 否则「成品链接」只是好看而已。
{
    const raw = oneQ?.get('url') || '';
    const feed = raw.replace(/^tag:[^,]+,provider:[^,]+,/, '');
    const r = await fetch(feed);
    const t = await r.text();
    ok('链接里的 feed 可直接拉通', r.status === 200, `HTTP ${r.status} · ${t.length} 字节`);
    ok('feed 有节点（不是空壳）', Number(r.headers.get('X-SubPilot-Nodes') || 0) > 0, `Nodes=${r.headers.get('X-SubPilot-Nodes')}`);
}

// ---- [4] 非 clash 目标不带前缀 ----
{
    const sb = await linkOf({ sub: A, target: 'singbox' });
    let q = null;
    try {
        q = new URL(sb.data.url || '').searchParams;
    } catch {}
    ok('singbox 目标：target 参数正确', q?.get('target') === 'singbox', q?.get('target') || '(无)');
    ok('singbox 目标不带 tag:/provider: 前缀', !/^tag:/.test(q?.get('url') || ''), (q?.get('url') || '').slice(0, 60) + '…');
    ok(
        'singbox 目标 url= 仍是本站 feed',
        (q?.get('url') || '').startsWith(`${BASE}/feed/sub/${A}?ft=`),
    );
}

// ---- [5] 参数透传：表单里改过的参数必须出现在链接里 ----
{
    const r = await linkOf({
        sub: A,
        target: 'clash',
        config: 'https://raw.githubusercontent.com/Aethersailor/Custom_OpenClash_Rules/refs/heads/main/cfg/Custom_Clash.ini',
        group: 'SubPilot',
        filename: 'demo.yaml',
        exclude: '(?i)剩余|官网',
        emoji: 'false',
        udp: 'true',
    });
    const q = new URL(r.data.url || '').searchParams;
    ok('config 透传', /Custom_Clash\.ini$/.test(q.get('config') || ''), (q.get('config') || '').slice(-24));
    ok('group 透传', q.get('group') === 'SubPilot', q.get('group') || '(无)');
    ok('filename 透传', q.get('filename') === 'demo.yaml', q.get('filename') || '(无)');
    ok('exclude 透传', q.get('exclude') === '(?i)剩余|官网', q.get('exclude') || '(无)');
    ok('emoji=false 显式下发', q.get('emoji') === 'false', q.get('emoji') || '(无)');
    ok('udp=true 显式下发', q.get('udp') === 'true', q.get('udp') || '(无)');
}

// ---- [6] 外部地址来源：原样透传（不折 feed） ----
{
    const r = await linkOf({ target: 'clash', url: 'https://example.com/sub' });
    const q = new URL(r.data.url || '').searchParams;
    ok('外部地址来源可用', r.status === 200, `HTTP ${r.status}`);
    ok('外部地址走直连（local=false）', r.data.local === false, String(r.data.local));
    ok(
        '外部地址按主机名包前缀',
        q.get('url') === 'tag:example.com,provider:example.com,https://example.com/sub',
        q.get('url') || '(无)',
    );
}

// ---- [7] 多来源：多条 feed 用 | 连成一条 url ----
{
    const r = await linkOf({ target: 'clash', url: `sp://${A}|sp://${B}` });
    const q = new URL(r.data.url || '').searchParams;
    const u = q.get('url') || '';
    const parts = u.split('|');
    ok('多来源返回链接', r.status === 200, `HTTP ${r.status}`);
    ok('两条来源各自成段', parts.length === 2, `${parts.length} 段`);
    ok('A 与 B 的 feed 都在', parts.some((p) => p.includes(`/feed/adhoc?`)) && parts.every((p) => /^tag:[^,]+,provider:[^,]+,/.test(p)));
}

// ---- [8] host 跟随自定义后端 ----
{
    const before = (await (await fetch(`${BASE}/api/settings`, { headers: H })).json()).data?.subBackend || '';
    const CUSTOM = 'https://sce.custom.invalid';
    const set = await fetch(`${BASE}/api/settings`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ subBackend: CUSTOM }),
    });
    ok('能写入自定义后端', set.status === 200, `HTTP ${set.status}`);

    const r = await linkOf({ sub: A, target: 'clash' });
    ok('自定义后端生效：链接 host 跟着变', (r.data.url || '').startsWith(`${CUSTOM}/sub?`), (r.data.url || '').slice(0, 60) + '…');

    // 还原（这一步必须成功，否则后面的转换类回归会全挂）
    const restore = await fetch(`${BASE}/api/settings`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ subBackend: before }),
    });
    ok('已还原原后端设置', restore.status === 200, `HTTP ${restore.status}`);
    const after = (await (await fetch(`${BASE}/api/settings`, { headers: H })).json()).data?.subBackend || '';
    ok('还原后与原来一致', after === before, `${after || '(空)'} vs ${before || '(空)'}`);
}

// ---- [9] 转换本身没被改坏（同一套参数走 /sub） ----
{
    const q = new URLSearchParams({ sub: A, target: 'clash', token: TOKEN });
    let status = 0;
    let processed = '';
    for (let i = 0; i < 3; i += 1) {
        const r = await fetch(`${BASE}/sub?${q}`);
        status = r.status;
        processed = r.headers.get('X-SubPilot-Processed') || '';
        await r.text();
        if (status === 200) break;
        await new Promise((res) => setTimeout(res, 1500));
    }
    ok('/sub 单订阅仍然可用', status === 200, `HTTP ${status}`);
    ok('/sub 仍走本地处理路径', processed === 'local', `Processed=${processed || '(无)'}`);
}

// ---- 收尾 ----
for (const name of [A, B]) {
    await fetch(`${BASE}/api/sub/${encodeURIComponent(name)}`, { method: 'DELETE', headers: H });
}
const left = await (await fetch(`${BASE}/api/subs`, { headers: H })).json();
ok('收尾：临时订阅已清理', !(left.data || []).some((s) => s.name === A || s.name === B));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
