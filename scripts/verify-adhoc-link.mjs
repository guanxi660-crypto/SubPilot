// 多来源（转换页一次勾选多个订阅）分发链路回归。
//
// 这里曾经藏着**两个**互相叠加的 bug，而且都不报错、只在多选时才暴露：
//
//   ① handleSub 解析 url 参数时不认识 sp:// 前缀。
//      转换页多选时前端发的是 url=sp://A|sp://B，但 handleSub 只拿 ref 去当「订阅名」
//      或「裸 URL」二选一 —— sp://A 两个都不是，于是被原样丢给 SCE，
//      得到 400「no valid proxy nodes or remote resources」。
//
//   ② adhoc spec 里没带每条订阅自己的 process。
//      spec 是唯一穿过 URL 的载体，少了它 /feed/adhoc → runPipeline 里 item.process 是空的，
//      每条订阅自己的 JSON 脚本被**静默跳过**（节点照出，只是没被筛选 / 改名 / 排序）。
//
// 用法：node scripts/verify-adhoc-link.mjs [baseUrl]
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
        { ps: `${tag}-新加坡 01`, add: 'sg.example.com' },
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

console.log(`\n== 多来源（adhoc）分发链路回归 @ ${BASE} ==\n`);

// ---- 播种：两个本地订阅，各自带**不同**的算子链 ----
// X 加国旗；Y 只保留香港。这样能同时验证「算子被应用」和「算子之间没有串」。
const X = '_vt_adhoc_x';
const Y = '_vt_adhoc_y';
for (const [name, process, content] of [
    [X, [{ type: 'Flag Operator', args: { mode: 'add' } }], NODES('X')],
    [Y, [{ type: 'Regex Filter', args: { regex: ['香港'], mode: 'keep' } }], NODES('Y')],
]) {
    const r = await fetch(`${BASE}/api/subs`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ name, source: 'local', content, process }),
    });
    ok(`播种 ${name}`, r.status === 201 || r.status === 200, `HTTP ${r.status}`);
}

// ---- [1] 复现原始 bug 的场景：/sub 直接吃 sp:// 多来源 ----
// 修好前这里必 400（no valid proxy nodes）。
// /sub 会把最终转换委托给远端 SCE，偶发 502 属网络抖动，重试几次再下结论。
{
    const q = new URLSearchParams({ target: 'clash', url: `sp://${X}|sp://${Y}`, token: TOKEN });
    let status = 0;
    let text = '';
    for (let i = 0; i < 3; i += 1) {
        const r = await fetch(`${BASE}/sub?${q}`);
        status = r.status;
        text = await r.text();
        if (status === 200) break;
        await new Promise((res) => setTimeout(res, 1500));
    }
    ok('/sub 多来源不再 400', status === 200, `HTTP ${status} · ${text.length} 字节`);
    const head = await fetch(`${BASE}/sub?${q}&emoji=true`);
    ok('走的是本地处理路径', head.headers.get('X-SubPilot-Processed') === 'local', `Processed=${head.headers.get('X-SubPilot-Processed')}`);
}

// ---- [2] POST /api/link：多来源也能拿到不含管理令牌的分发链接 ----
// 修好前前端只能拿到空字符串 —— 「多选几个订阅，分发链接整个消失」。
const lr = await fetch(`${BASE}/api/link`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ sources: [`sp://${X}`, `sp://${Y}`], process: [], target: 'clash' }),
});
const lj = await lr.json().catch(() => ({}));
const link = lj.data?.link || '';
const feedUrl = lj.data?.feedUrl || '';
ok('POST /api/link 可用', lr.status === 200, `HTTP ${lr.status}`);
ok('返回分发链接', /^\/download\/adhoc\?/.test(link.replace(BASE, '')), link.replace(BASE, '').slice(0, 60) + '…');
ok('返回 feed 地址', /^\/feed\/adhoc\?/.test(feedUrl.replace(BASE, '')));
ok('链接不含管理令牌', !/[?&]token=/.test(link));

// ---- [3] /download/adhoc 无令牌可用 ----
if (link) {
    const dl = await fetch(link);
    const dt = await dl.text();
    ok('/download/adhoc 无令牌可访问', dl.status === 200, `HTTP ${dl.status}`);
    // Sub-Store 模式（见 convert.js handleDownload / buildLinks 注释）：
    // 分发链接一律输出**编辑后的订阅**，target 参数被忽略、不做客户端转换。
    // 这里的来源是本地 vmess 订阅 → 产出 base64(URI 列表) 的通用订阅，
    // 不再产出 Clash 配置。旧断言查 proxy-providers 是转换时代的遗留。
    const decoded = Buffer.from(dt.trim(), 'base64').toString('utf8');
    ok(
        '产出是通用订阅（base64 URI 列表）',
        /^(ss|vless|vmess|trojan|hysteria2|tuic):\/\//m.test(decoded),
        decoded.slice(0, 40).replace(/\n/g, '⏎') + '…',
    );
    ok('不再做客户端转换（无 proxy-providers）', !/proxy-providers:/.test(dt));
    ok('格式标记为 uri', dl.headers.get('x-subpilot-format') === 'uri', dl.headers.get('x-subpilot-format') || '(无)');
    ok('产出不含访问令牌', !dt.includes(TOKEN));
}

// ---- [4] /feed/adhoc：每条订阅自己的算子都生效 ----
if (feedUrl) {
    const fr = await fetch(feedUrl);
    const raw = await fr.text();
    ok('/feed/adhoc 无令牌可访问', fr.status === 200, `HTTP ${fr.status} · Nodes=${fr.headers.get('X-SubPilot-Nodes')}`);

    // feed 输出保持「原始格式」。本地订阅是 vmess:// 列表，serializeNodes 对 uri 格式
    // 会把整个列表再包一层 base64 —— 所以先解最外层，再逐条解 vmess 载荷。
    let body = raw.trim();
    if (!/vmess:\/\//.test(body)) {
        try {
            const d = Buffer.from(body, 'base64').toString('utf8');
            if (/vmess:\/\//.test(d)) body = d;
        } catch {}
    }
    const names = [...body.matchAll(/vmess:\/\/([A-Za-z0-9+/=_-]+)/g)]
        .map((m) => {
            try {
                return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')).ps || '';
            } catch {
                return '';
            }
        })
        .filter(Boolean);

    // 节点数：X 贡献 3 个 + Y（只留香港）贡献 1 个 = 4。若 Y 的算子被丢掉会是 6。
    ok('节点数符合「各算子已生效」', names.length === 4, `${names.length} 个（应为 4）`);
    // X 的 Flag Operator：名字带国旗
    ok('X 的 Flag Operator 生效', names.some((n) => /🇭🇰|🇯🇵|🇸🇬/.test(n)));
    // Y 的 Regex Filter(keep 香港)：Y 的节点里不该出现日本 / 新加坡。
    // 注意只能看 Y 前缀的 —— X 里本来就有日本 / 新加坡节点。
    const yNodes = names.filter((n) => /^Y-/.test(n));
    ok('Y 的 keep-香港 生效', yNodes.length === 1 && /香港/.test(yNodes[0]), yNodes.join(',') || '(无 Y 节点)');
}

// ---- [5] 密钥校验 ----
if (link) {
    const bad = await fetch(link.replace(/ft=[^&]+/, 'ft=deadbeef'));
    ok('篡改 ft 返回 403', bad.status === 403, `HTTP ${bad.status}`);
    const noFt = await fetch(link.replace(/&ft=[^&]+/, ''));
    ok('去掉 ft 返回 403', noFt.status === 403, `HTTP ${noFt.status}`);
}

// ---- 收尾 ----
for (const name of [X, Y]) {
    await fetch(`${BASE}/api/sub/${encodeURIComponent(name)}`, { method: 'DELETE', headers: H });
}
const left = await (await fetch(`${BASE}/api/subs`, { headers: H })).json();
ok('收尾：临时订阅已清理', !(left.data || []).some((s) => s.name === X || s.name === Y));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
