// Node 适配层回归：**响应压缩缓存绝不能串响应**。
//
// 起因（2026-10-10）：server.mjs 的 cacheKey 曾用「长度 + 首字节 + 末字节」当键。
// 两次长度相同、首尾都是 `{` / `}` 的响应会撞键，于是后一次请求拿到的是
// **上一次那条响应的压缩体** —— 客户端看到「POST 返回 201，但响应里没有刚建的
// 那一项」，而库里其实写成功了。表现极像存储层丢数据，排查半天才发现是适配层
// 的缓存键。同长度的两个响应一旦撞键，等于把别人的内容发给了你：静默返回错数据，
// 比慢一点严重得多。
//
// 构造方式：两个**等长**的成品名 + 等长但标记不同的正文 → 两次单条 GET 的响应
// 长度完全一致、内容不同，正好落进当年会撞键的形状里。
// ⚠️ 响应必须 ≥ COMPRESS_MIN(1024) 才会进压缩缓存，所以正文取 ~1.2KB；
// 小于阈值时这条回归会「恒真」，等于没测。
// ⚠️ 只对 Node / Docker 自建部署有意义：Cloudflare Workers 不走这段代码。
//
// 用法：node scripts/verify-node-adapter.mjs [baseUrl]
// 前置：本地服务已起（8795）

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

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
// 显式要 gzip：不给 Accept-Encoding 就压不了，这条回归也就测不到东西
const HG = { ...H, 'Accept-Encoding': 'gzip' };

const stamp = Date.now().toString(36);
const NAME_A = `_na_aa_${stamp}`;
const NAME_B = `_na_bb_${stamp}`;
const PAD = 'x'.repeat(1200);
const bodyOf = (marker) => `# MARKER-${marker}\n${PAD}\n`;

async function post(name, content) {
    const res = await fetch(`${BASE}/api/converted`, {
        method: 'POST',
        headers: HG,
        body: JSON.stringify({ name, target: 'clash', template: '', content }),
    });
    return { status: res.status, text: await res.text() };
}
async function getOne(name) {
    const res = await fetch(`${BASE}/api/converted/${encodeURIComponent(name)}`, { headers: HG });
    return { status: res.status, text: await res.text() };
}
const del = (n) => fetch(`${BASE}/api/converted/${encodeURIComponent(n)}`, { method: 'DELETE', headers: H });

console.log(`\n== Node 适配层回归（响应压缩缓存） @ ${BASE} ==\n`);

ok('两个测试名等长（构造撞键形状）', NAME_A.length === NAME_B.length, `${NAME_A} / ${NAME_B}`);
ok('两份正文等长', bodyOf(NAME_A).length === bodyOf(NAME_B).length, `${bodyOf(NAME_A).length} 字节`);

const pa = await post(NAME_A, bodyOf(NAME_A));
const pb = await post(NAME_B, bodyOf(NAME_B));
ok('两条成品都已建好', pa.status === 201 && pb.status === 201, `HTTP ${pa.status} / ${pb.status}`);

// 关键顺序：先读 A（把 A 的压缩体写进缓存），再读 B（旧实现会命中 A 的键）
const ga = await getOne(NAME_A);
const gb = await getOne(NAME_B);
ok('读 A 成功', ga.status === 200, `HTTP ${ga.status} · ${ga.text.length} 字节`);
ok('读 B 成功', gb.status === 200, `HTTP ${gb.status} · ${gb.text.length} 字节`);
ok('A 的响应里是 A 的标记', ga.text.includes(`MARKER-${NAME_A}`), `${ga.text.length} 字节`);
ok('B 的响应里是 B 的标记（不是 A 的缓存体）', gb.text.includes(`MARKER-${NAME_B}`), `${gb.text.length} 字节`);
ok('B 的响应里没有 A 的标记', !gb.text.includes(`MARKER-${NAME_A}`), gb.text.slice(0, 140) + '…');
ok(
    '两次响应长度相同（证明确实落在会撞键的形状上）',
    ga.text.length === gb.text.length,
    `${ga.text.length} vs ${gb.text.length}`,
);
ok('两次响应都 ≥1024 字节（确实进了压缩缓存）', ga.text.length >= 1024 && gb.text.length >= 1024);
ok('两次响应内容不同', ga.text !== gb.text);

// 收尾
for (const n of [NAME_A, NAME_B]) await del(n);
const left = await (await fetch(`${BASE}/api/converted`, { headers: H })).json();
ok('收尾：测试成品已清理', !(left.data || []).some((x) => x.name === NAME_A || x.name === NAME_B));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
