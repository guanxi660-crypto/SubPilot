// 第二十轮回归：转换成品（converted）的「分享链接」与「TG 推送」两条新通道。
//
// 为什么单独写：verify.mjs 的 [8] 只覆盖了 sub 分享码，[14] 只覆盖了 TG 配置读写，
// 而成品分享是本轮新增的**第三条分享路径** —— 它和前两条有本质差别：
//   sub / col 是原始订阅，/share/<kind>/… 要交给 SCE 现转；
//   file 是本地文本或 302 跳转；
//   converted 是「已经转好的快照」，必须**原样吐出**，再转一次就毁了。
// 这条差别一旦被后人改错（比如顺手复用 handleSub 的分支），
// 表现是「分享链接能打开但内容是二次转换后的垃圾」，不会报错，所以必须固化断言。
//
// 用法：node scripts/verify-converted-share.mjs [baseUrl]

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
    if (cond) {
        pass += 1;
        console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
    } else {
        fail += 1;
        console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
    }
}

async function req(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (options.auth !== false) headers.Authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { ...options, headers });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* 非 JSON */
    }
    return { res, text, json };
}

const NAME = `_vt_conv_${Date.now().toString(36)}`;

// 故意造一份「看起来像 Clash、但绝不可能由 SCE 生成」的内容：
// 只要 /share/converted 返回的是它，就证明中间没有再跑一次转换。
const CONTENT = [
    'proxies:',
    `  - {name: "SHARE-CANARY-${NAME}", type: vmess, server: canary.example.com, port: 443, uuid: 11111111-1111-1111-1111-111111111111, alterId: 0, cipher: auto}`,
    '',
].join('\n');

console.log(`\n== 成品分享 / TG 推送回归 @ ${BASE} ==\n`);

// ---- 准备：造一个成品 ----
// ⚠️ 成品的分享链接是「保存即定下」的 —— 后端在这一步就自动建好永久分享码，
// 并把 code 挂在返回的列表项上（shareCode 字段）。这条是本轮最核心的行为。
// 2026-10-10 起保存还要带**活链**（产出面板那条「成品链接」，这次转换实际打到
// 的后端地址）—— 卡片复制 / TG 推送都原样用它，与产出面板逐字一致。
const LIVE_URL =
    'https://sce.example.test/sub?target=clash&url=' +
    encodeURIComponent(`tag:VT,provider:VT,${BASE}/feed/sub/_vt_conv_src?ft=vtft`) +
    '&emoji=false';
// 重存（target=shadowrocket）时前端会交上来的新活链
const LIVE_URL2 = LIVE_URL.replace('target=clash', 'target=shadowrocket');
const made = await req('/api/converted', {
    method: 'POST',
    body: JSON.stringify({ name: NAME, target: 'clash', template: '', content: CONTENT, backendUrl: LIVE_URL }),
});
ok('创建成品', made.res.status === 201, `HTTP ${made.res.status} · 响应体 ${made.text.length} 字节`);
const created = (made.json?.data || []).find((x) => x.name === NAME);
ok('保存后立即带 shareCode', !!created?.shareCode, created?.shareCode || '(空)');
ok('列表项带 size 且不泄漏 content', typeof created?.size === 'number' && !('content' in (created || {})), `size=${created?.size}`);

// ---- 成品链接（活链）：卡片复制 / TG 推送用的都是它 ----
// 形状 = 保存时存下的那条后端地址（url= 指向本站 /feed 活链，内容跟随订阅更新）。
const parseLink = (s) => {
    try {
        return new URL(s);
    } catch {
        return null;
    }
};
const convLink = parseLink(created?.link || '');
ok('列表项带 link（成品链接）', !!convLink && /\/sub$/.test(convLink.pathname), created?.link || '(空)');
ok('成品链接 = 保存时存下的那条活链（逐字一致）', created?.link === LIVE_URL, created?.link || '(空)');
ok('成品链接带 target=<成品格式>', convLink?.searchParams.get('target') === 'clash', created?.link || '');
ok('成品链接带后端域名（不是本站 /share 直链）', !!convLink && !convLink.pathname.includes('/share/'), created?.link || '');
ok('成品链接的 url= 指向本站 /feed 活链', (convLink?.searchParams.get('url') || '').includes('/feed/sub/'), convLink?.searchParams.get('url') || '(空)');
ok('成品链接不再是快照链（url= 不指向 /share/converted）', !(convLink?.searchParams.get('url') || '').includes('/share/converted/'), convLink?.searchParams.get('url') || '(空)');
ok('成品链接上没有任何来源标记', !/[?&]src=/.test(created?.link || ''), created?.link || '');

// 活链校验：非 http(s) 一律拒收（否则卡片链接可能变成 javascript: 之类载体）
{
    const bad = await req('/api/converted', {
        method: 'POST',
        body: JSON.stringify({ name: NAME, target: 'clash', template: '', content: CONTENT, backendUrl: 'javascript:alert(1)' }),
    });
    ok('非 http(s) 的成品链接被拒收', bad.res.status === 400, `HTTP ${bad.res.status}`);
}

// ---- 老成品退路：没存活链的（该字段上线前保存的）退回快照链 ----
// 形状 = <转换后端>/sub?target=<成品格式>&url=<成品自身的快照>&config=<模板>
const NAME2 = `_vt_conv_legacy_${Date.now().toString(36)}`;
const made2 = await req('/api/converted', {
    method: 'POST',
    body: JSON.stringify({ name: NAME2, target: 'clash', template: '', content: CONTENT }),
});
ok('创建老格式成品（不带 backendUrl）', made2.res.status === 201, `HTTP ${made2.res.status}`);
const legacy = (made2.json?.data || []).find((x) => x.name === NAME2);
const legacyLink = parseLink(legacy?.link || '');
ok('老成品退回快照链（/sub? 形状）', !!legacyLink && /\/sub$/.test(legacyLink.pathname), legacy?.link || '(空)');
{
    const inner = parseLink(legacyLink?.searchParams.get('url') || '');
    ok(
        '老成品快照链的 url= 指向该成品自身的快照',
        !!inner && inner.pathname === `/share/converted/${NAME2}` && inner.searchParams.get('code') === legacy?.shareCode,
        legacyLink?.searchParams.get('url') || '(空)',
    );
}

// 固定链接语义：重存（改 target）后 code 必须原封不动 ——
// 否则客户端配置里嵌的地址一换，所有人都得重新分发一遍。
const FIXED_CODE = created?.shareCode || '';
if (FIXED_CODE) {
    const url1 = `${BASE}/share/converted/${encodeURIComponent(NAME)}?code=${FIXED_CODE}`;
    const hit1 = await fetch(url1);
    ok('固定链接可直接访问', hit1.status === 200, `HTTP ${hit1.status}`);
    ok('固定链接返回原内容', (await hit1.text()) === CONTENT);

    // 重存带新活链：target 变了，前端会把新一条成品链接交上来 —— link 必须跟着换
    await req('/api/converted', {
        method: 'POST',
        body: JSON.stringify({ name: NAME, target: 'shadowrocket', template: '', content: CONTENT + '#v2\n', backendUrl: LIVE_URL2 }),
    });
    const again = await req('/api/converted');
    const it2 = (again.json?.data || []).find((x) => x.name === NAME);
    ok('重存后 shareCode 不变', it2?.shareCode === FIXED_CODE, `${it2?.shareCode}`);
    ok('重存后 target 已更新', it2?.target === 'shadowrocket', it2?.target);
    ok('重存后成品链接换成新活链', it2?.link === LIVE_URL2, it2?.link || '(空)');
    const hit2 = await fetch(url1);
    ok('重存后固定链接仍然有效', hit2.status === 200, `HTTP ${hit2.status}`);
    ok('重存后返回的是新内容', (await hit2.text()) === CONTENT + '#v2\n');
}

// ---- [1] 分享码能接受 converted 类型（手工建码的入口仍保留）----
// 注意：POST /api/shares 返回的是**新建的那一条**（不是整个列表）。
const gen = await req('/api/shares', {
    method: 'POST',
    body: JSON.stringify({ type: 'converted', name: NAME, options: { kind: 'days', days: 7 } }),
});
const code = gen.json?.data?.code;
ok('为成品生成分享码', !!code && gen.json?.data?.type === 'converted', code || gen.text.slice(0, 160));

// 多条码会在下一次保存时被归一成最早的那条（且转为永久）——
// 这是为了让「固定链接」名副其实：一个成品只对外暴露一个地址。
if (code && FIXED_CODE) {
    await req('/api/converted', {
        method: 'POST',
        body: JSON.stringify({ name: NAME, target: 'shadowrocket', template: '', content: CONTENT + '#v3\n', backendUrl: LIVE_URL2 }),
    });
    const shares = await req('/api/shares');
    const mine = (shares.json?.data || []).filter((s) => s.type === 'converted' && s.name === NAME);
    ok('多余分享码被归一成一条', mine.length === 1, `剩 ${mine.length} 条`);
    ok('保留的是最早那条', mine[0]?.code === FIXED_CODE);
    ok('固定链接归一为永久有效', mine[0]?.expiresAt === null, `expiresAt=${mine[0]?.expiresAt}`);
}

// ---- [2] 无码 / 错码 / 错名一律 403 ----
if (code) {
    const noCode = await fetch(`${BASE}/share/converted/${encodeURIComponent(NAME)}`);
    ok('不带 code 返回 403', noCode.status === 403, `HTTP ${noCode.status}`);

    const badCode = await fetch(`${BASE}/share/converted/${encodeURIComponent(NAME)}?code=nope`);
    ok('错误 code 返回 403', badCode.status === 403, `HTTP ${badCode.status}`);

    const badName = await fetch(`${BASE}/share/converted/${encodeURIComponent('__nope__')}?code=${code}`);
    ok('名称不匹配返回 403', badName.status === 403, `HTTP ${badName.status}`);

    // 手工建的那条 7 天码在归一后已被回收，用它访问必须 403 ——
    // 这正是「一个成品只对外暴露一个地址」的另一面。
    const staleCode = await fetch(`${BASE}/share/converted/${encodeURIComponent(NAME)}?code=${code}`);
    ok('被归一掉的旧码已失效', staleCode.status === 403, `HTTP ${staleCode.status}`);

    // ---- [3] 正确链接：内容**逐字节原样**返回（这是本轮最关键的断言）----
    // 注意：此刻内容已经被上面的「重存」覆盖成 #v3 了 ——
    // 断言的是「返回的就是当前那份成品，一字不差」，而不是最早那份。
    const hit = await fetch(`${BASE}/share/converted/${encodeURIComponent(NAME)}?code=${FIXED_CODE}`);
    const body = await hit.text();
    ok('正确分享码可访问', hit.status === 200, `HTTP ${hit.status}`);
    ok(
        '内容是原样吐出的快照（没有再走一次转换）',
        body === CONTENT + '#v3\n',
        body === CONTENT + '#v3\n' ? `${body.length} 字节一致` : `实得 ${body.length} 字节`,
    );
    ok('保留了 canary 标记', body.includes(`SHARE-CANARY-${NAME}`));
    // 此时 target 已被重存成 shadowrocket —— 它是 base64 明文订阅，所以 Content-Type 应该是 text/plain。
    // YAML 那条分支由最开头的 clash 保存验证过，这里验证的是「跟着 target 走」这件事本身。
    ok(
        'Content-Type 跟着 target 走（shadowrocket → text/plain）',
        /text\/plain/.test(hit.headers.get('content-type') || ''),
        hit.headers.get('content-type') || '',
    );
    ok('带 CORS 头', hit.headers.get('access-control-allow-origin') === '*');

    // ---- [4] 分享码列表里能查到，且 type 正确 ----
    const list = await req('/api/shares');
    const row = (list.json?.data || []).find((s) => s.code === FIXED_CODE);
    ok('分享列表里 type=converted', row?.type === 'converted', JSON.stringify(row || {}));
}

// ---- [5] TG：成品能被识别为合法推送目标 ----
// 这里不真的发消息（会打扰用户的 TG），只验证「配置能存下 converted 目标」这一环：
// 后端 findTarget / KIND_LABEL 若没加 converted，保存时就会被白名单挡掉。
const before = await req('/api/telegram/config');
const savedTargets = before.json?.data?.targets || [];
const withConv = [...savedTargets.filter((t) => t.kind !== 'converted'), { kind: 'converted', name: NAME }];
const saveTg = await req('/api/telegram/config', {
    method: 'POST',
    body: JSON.stringify({
        token: '',
        chatIds: before.json?.data?.chatIds || '8600129634',
        targets: withConv,
        linkType: before.json?.data?.linkType || '',
        autoPush: false,
    }),
});
ok('TG 配置接受 converted 目标', saveTg.res.status === 200, `HTTP ${saveTg.res.status}`);

const after = await req('/api/telegram/config');
const kept = (after.json?.data?.targets || []).some((t) => t.kind === 'converted' && t.name === NAME);
ok('converted 目标已落库', kept, JSON.stringify(after.json?.data?.targets || []));

// 还原：把 converted 目标摘掉，别给用户留下指向临时成品的推送项
await req('/api/telegram/config', {
    method: 'POST',
    body: JSON.stringify({
        token: '',
        chatIds: before.json?.data?.chatIds || '8600129634',
        targets: savedTargets,
        linkType: before.json?.data?.linkType || '',
        autoPush: !!before.json?.data?.autoPush,
    }),
});
ok('已还原 TG 目标列表', true);

// ---- [6] 删除成品要连带回收分享码 ----
const del = await req(`/api/converted/${encodeURIComponent(NAME)}`, { method: 'DELETE' });
ok('删除成品成功', del.res.status === 200, `HTTP ${del.res.status}`);

// 老格式成品一并清掉
const del2 = await req(`/api/converted/${encodeURIComponent(NAME2)}`, { method: 'DELETE' });
ok('删除老格式成品成功', del2.res.status === 200, `HTTP ${del2.res.status}`);

const list2 = await req('/api/shares');
const dead = (list2.json?.data || []).filter(
    (s) => s.type === 'converted' && (s.name === NAME || s.name === NAME2),
);
ok('分享码随成品一起被回收', !dead.length, dead.length ? `仍存在：${JSON.stringify(dead)}` : '已清除');

for (const c of [code, FIXED_CODE].filter(Boolean)) {
    const gone = await fetch(`${BASE}/share/converted/${encodeURIComponent(NAME)}?code=${c}`);
    ok('旧分享链接已失效', gone.status === 403, `HTTP ${gone.status}`);
}
const gone2 = await fetch(`${BASE}/share/converted/${encodeURIComponent(NAME2)}?code=${legacy?.shareCode}`);
ok('老格式成品的分享链接也已失效', gone2.status === 403, `HTTP ${gone2.status}`);

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
