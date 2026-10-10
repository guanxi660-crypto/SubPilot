// TG 推送链接与「分发统计」口径（2026-10-10 改版）。
//
// 两条用户明确要求，本脚本把它们钉死：
//   ① 「推送给 TG 的链接不应该有 &src=tg，原链接是什么推送什么」——
//      推送正文里的链接必须与分发链接**逐字相同**，URL 上不许附加任何来源标记。
//      此前用 `src=tg` 做「TG 抓预览不计统计」的判据，那个方案已被否掉。
//   ② 「推送给 TG 的成品链接应该是成品链接（活链）」——
//      2026-10-10 晚改定：保存成品时把产出面板那条后端地址（活链）原样存下来，
//      推送 / 卡片复制都原样用它；老成品（没存活链）退回快照链。
//      两条路径都由 convertedBackendLink 产出，与卡片复制不可能漂移。
//
// 统计侧改判据后仍要保证：TG 服务器抓预览的那一跳不计入分发统计，
// 而**真人**的拉取照常计入（旧标记方案会把真人从 TG 点开的也一并抹掉）。
// 判据是 UA 含 TelegramBot —— TG 预览爬虫自报 `TelegramBot (like TwitterBot)`。
//
// 两段：
//   · 单元段 —— 内存 KV + 拦截 globalThis.fetch，直接调 handleTelegram 的
//     /api/telegram/push，检查**真正发给 TG 的消息正文**里的链接。
//   · HTTP 段 —— 打真实本地服务：同一条链接，普通 UA 计一次、TelegramBot 不计、
//     换个浏览器 UA 又计一次；且 UA 不影响响应正文。
//
// 用法：node scripts/verify-tg-stats.mjs [baseUrl]
// 需要先起本地服务：SUBPILOT_TOKEN=dev-local-token PORT=8795 node apps/server/node/server.mjs
// ⚠️ 同一时刻只能起一个本地服务：SQLite 被两个进程同时打开时，内存缓存会互相覆盖，
//    统计计数会「只记第一次」（1→1→1）。

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════ [1] 单元：推送链接就是原链接
console.log('\n[1] 单元 · 推给 TG 的链接是原链接（无来源标记）');

const { handleTelegram } = await import('../apps/server/src/telegram.js');
const { buildLinks, convertedBackendLink } = await import('../apps/server/src/convert.js');

// ---- 内存 KV（storage.js 的 kvDriver 契约：get(key, 'json') / put(key, string)）----
const SNAPSHOT_KEY = 'panel:snapshot:v1';
const kv = new Map();
const env = {
    SUBPILOT_TOKEN: 'verify-token',
    DATA: {
        async get(k, type) {
            if (!kv.has(k)) return null;
            const v = kv.get(k);
            return type === 'json' ? JSON.parse(v) : v;
        },
        async put(k, v) {
            kv.set(k, v);
        },
    },
};

const SUB = '单元订阅';
const FILE = 'unit.txt';
const CONV = 'unit-clash';
const PUB = 'https://sp.test';
const SCE = 'https://sce.test';
const snapshot = {
    app: 'SubPilot',
    version: 1,
    rev: 1,
    subs: [{ name: SUB, displayName: '示例订阅', source: 'remote', url: ['https://example.com/a'], process: [] }],
    collections: [],
    files: [{ name: FILE, displayName: '示例文件', source: 'local', content: 'hello' }],
    converted: [{ name: CONV, target: 'clash', template: 'https://example.com/cfg.ini', content: 'proxies: []' }],
    shares: [],
    templates: [],
    settings: {
        // 固定对外基地址 / 后端，让链接可预测（否则取请求来源 / 部署默认后端）
        publicBaseUrl: PUB,
        subBackend: SCE,
        // 有盐才能派生分发密钥（feedkey.js 的 deriveFeedKey）
        feedSalt: 'verify-salt',
        telegram: {
            token: '123456:VERIFY_FAKE_TOKEN',
            chatIds: '1001',
            targets: [],
            linkType: '',
            autoPush: false,
            lastPush: null,
        },
    },
};
kv.set(SNAPSHOT_KEY, JSON.stringify(snapshot));

// ---- 拦下发往 TG 的请求，把消息正文留下来 ----
const realFetch = globalThis.fetch;
const sentBodies = [];
globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
        sentBodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: sentBodies.length } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    return realFetch(url, init);
};

const ctx = { waitUntil() {}, passThroughOnException() {} };
const pushReq = new Request(`${PUB}/api/telegram/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        targets: [
            { kind: 'sub', name: SUB },
            { kind: 'file', name: FILE },
            { kind: 'converted', name: CONV },
        ],
    }),
});
const pushRes = await handleTelegram(pushReq, env, ctx, {
    path: '/api/telegram/push',
    query: new URLSearchParams(),
    method: 'POST',
});
const pushJson = await pushRes.json();
globalThis.fetch = realFetch;

ok('推送接口调用成功（3 个目标合成 1 条消息）', pushRes.status === 200 && pushJson?.data?.sent === 1, `HTTP ${pushRes.status} sent=${pushJson?.data?.sent}`);

const text = sentBodies[0]?.text || '';
ok('拿到了发往 TG 的消息正文', text.length > 0, `${text.length} 字符`);

// 消息里的链接写在反引号代码块里，escCode 只转义反斜杠与反引号 —— URL 本身原样保留
const urls = [...text.matchAll(/https?:\/\/[^\s`\\]+/g)].map((m) => m[0]);
ok('正文里带上了 3 条链接', urls.length === 3, urls.length ? urls.join('\n      ') : text.slice(0, 200));

const subUrl = urls.find((u) => u.includes('/download/')) || '';
const fileUrl = urls.find((u) => u.includes('/share/file/')) || '';
const convUrl = urls.find((u) => u.includes('/sub?')) || '';

const hasSrc = (u) => {
    try {
        return new URL(u).searchParams.has('src');
    } catch {
        return false;
    }
};

// ---- 核心断言 ①：链接上不许有任何来源标记 ----
ok('订阅推送链接不带任何 src 参数', subUrl && !hasSrc(subUrl), subUrl);
ok('文件推送链接不带任何 src 参数', fileUrl && !hasSrc(fileUrl), fileUrl);
ok('成品推送链接不带任何 src 参数', convUrl && !hasSrc(convUrl), convUrl);
ok('正文里完全不出现 src=tg', !text.includes('src=tg'));

// ---- 订阅：推送链接 = buildLinks 直出的分发链接（逐字相同）----
const direct = await buildLinks({ url: `${PUB}/` }, env, snapshot, { kind: 'sub', name: SUB });
ok('订阅推送链接与「复制订阅」直出链接逐字相同', subUrl === direct.link, `${direct.link}\n      → ${subUrl}`);
ok('订阅链接仍带派生密钥 ft=', /[?&]ft=[A-Za-z0-9_-]{16,}/.test(subUrl), subUrl);

// ---- 文件：推送链接 = /share/file 快照直链（文件没有后端格式可言）----
const freshSnap = JSON.parse(kv.get(SNAPSHOT_KEY));
const fileCode = (freshSnap.shares || []).find((s) => s.type === 'file' && s.name === FILE)?.code || '';
ok('推送时为文件建好了分享码', !!fileCode, fileCode || '(空)');
ok(
    '文件推送链接 = /share/file/<名>?code=<码>',
    fileUrl === `${PUB}/share/file/${encodeURIComponent(FILE)}?code=${fileCode}`,
    fileUrl,
);

// ---- 核心断言 ②：成品推的是「成品链接」（活链 —— 保存时存下的那条后端地址）----
const convItem = freshSnap.converted.find((c) => c.name === CONV);
const convCode = (freshSnap.shares || []).find((s) => s.type === 'converted' && s.name === CONV)?.code || '';
ok('推送时为成品建好了分享码', !!convCode, convCode || '(空)');

const expectedConv = convertedBackendLink({ env, snap: freshSnap, item: convItem, base: PUB, code: convCode });
ok('成品推送链接 = convertedBackendLink 的产出（与卡片复制同源）', convUrl === expectedConv, `期望 ${expectedConv}\n      → ${convUrl}`);
ok('成品链接带后端域名（不是本站域名）', convUrl.startsWith(`${SCE}/sub?`), convUrl.slice(0, 60));
ok('成品链接带 target=<成品格式>', convUrl.includes('target=clash'), convUrl);
ok('成品链接带 config=<模板>', convUrl.includes(`config=${encodeURIComponent(convItem.template)}`), convUrl);
ok('成品链接的 url= 指向成品自身的快照（老成品退路）', new URL(convUrl).searchParams.get('url') === `${PUB}/share/converted/${encodeURIComponent(CONV)}?code=${convCode}`, String(new URL(convUrl).searchParams.get('url')));

// 2026-10-10 起的主路径：保存时存了**活链**的成品，推送 / 卡片复制都原样用它 ——
// 不重写一个字符（改一个字符都可能让它失效），也不再依赖分享码。
const LIVE = `${SCE}/sub?target=clash&url=${encodeURIComponent(`${PUB}/feed/sub/${SUB}?ft=tgstatsft`)}`;
ok(
    '存了活链的成品：convertedBackendLink 原样返回它',
    convertedBackendLink({ env, snap: freshSnap, item: { ...convItem, backendUrl: LIVE }, base: PUB, code: convCode }) === LIVE,
);
ok(
    '存了活链的成品：没有分享码也产得出链接',
    convertedBackendLink({ env, snap: { ...freshSnap, shares: [] }, item: { ...convItem, backendUrl: LIVE }, base: PUB }) === LIVE,
);

// ---- 边界：老成品（没存活链）拿不到分享码时不产出链接 ----
ok(
    '老成品没有分享码时不产出成品链接（调用方退回 /share 直链）',
    convertedBackendLink({ env, snap: { ...freshSnap, shares: [] }, item: convItem, base: PUB }) === '',
);
ok('没有对外基地址时不产出成品链接', convertedBackendLink({ env, snap: freshSnap, item: convItem, base: '' }) === '');

// ══════════════════════════════════════════ [2] HTTP：统计口径
console.log('\n[2] HTTP · TelegramBot 抓预览不计入分发统计，真人照常计');

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const api = async (method, path, body) => {
    const r = await realFetch(BASE + path, {
        method,
        headers: H,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    const raw = await r.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch {
        /* 非 JSON */
    }
    return { status: r.status, raw, json };
};

/** 某个项目在统计里的累计次数（key 是「类型|项目|IP」，按项目聚合） */
const countsFor = async (item) => {
    const r = await api('GET', '/api/stats');
    return (r.json?.data?.items || [])
        .filter((x) => x.item === item)
        .reduce((n, x) => n + (Number(x.count) || 0), 0);
};

/** 把任意来源的链接折成「本机服务的相对路径」—— 库里的 publicBaseUrl 可能指向线上域名 */
const toLocal = (url) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
};

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TG_UA = 'TelegramBot (like TwitterBot)';

// ---- /download 通道（订阅 / 组合）----
const SUB2 = '__verify_tgstats__';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const NODES = [
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#TG统计A',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.5:8388#TG统计B',
].join('\n');

await api('DELETE', `/api/sub/${encodeURIComponent(SUB2)}`);
const created = await api('POST', '/api/subs', {
    name: SUB2,
    displayName: 'TG 统计用例',
    source: 'local',
    content: b64(NODES),
    process: [],
});
ok('建出本地内容订阅（不外网）', created.status === 201, `HTTP ${created.status}`);

const linkRes = await api('GET', `/api/link?kind=sub&name=${encodeURIComponent(SUB2)}`);
const shareLink = linkRes.json?.data?.link || '';
ok('拿到分发链接（/download + 派生密钥）', /\/download\//.test(shareLink) && /[?&]ft=/.test(shareLink), shareLink);

const local = toLocal(shareLink);
const before = await countsFor(SUB2);

const plain = await realFetch(BASE + local, { headers: { 'User-Agent': BROWSER_UA } });
const plainBody = await plain.text();
await sleep(400);
const afterPlain = await countsFor(SUB2);
ok('真人（浏览器 UA）拉取计一次', afterPlain === before + 1, `${before} → ${afterPlain}`);

const tg = await realFetch(BASE + local, { headers: { 'User-Agent': TG_UA } });
const tgBody = await tg.text();
await sleep(400);
const afterTg = await countsFor(SUB2);
ok('TelegramBot 抓预览一次都不计', afterTg === afterPlain, `${afterPlain} → ${afterTg}`);
ok(
    'UA 不影响分发本身（状态码与正文逐字相同）',
    plain.status === 200 && plainBody.length > 50 && tg.status === plain.status && tgBody === plainBody,
    `HTTP ${plain.status}/${tg.status} · ${plainBody.length}/${tgBody.length} 字节`,
);

// 连抓两次也不计，确认不是「只跳过一次」
await (await realFetch(BASE + local, { headers: { 'User-Agent': TG_UA } })).text();
await sleep(400);
ok('连抓两次 TelegramBot 也仍然不计', (await countsFor(SUB2)) === afterTg, `仍为 ${afterTg}`);

// 换个真人 UA 再拉一次 —— 证明判据没有误伤普通客户端
await (await realFetch(BASE + local, { headers: { 'User-Agent': 'clash-verge/v2.0' } })).text();
await sleep(400);
const afterClient = await countsFor(SUB2);
ok('换客户端 UA 的真人拉取照常计一次', afterClient === afterTg + 1, `${afterTg} → ${afterClient}`);

// ---- /share 通道（文件）----
const FILE2 = '__verify_tgstats__.txt';
await api('DELETE', `/api/file/${encodeURIComponent(FILE2)}`);
await api('POST', '/api/files', { name: FILE2, source: 'local', content: 'hello tg' });
const sh = await api('POST', '/api/shares', { type: 'file', name: FILE2 });
const code = sh.json?.data?.code || '';
ok('建出文件分享码', !!code, `HTTP ${sh.status} code=${code}`);

if (code) {
    const sharePath = `/share/file/${encodeURIComponent(FILE2)}?code=${code}`;
    const fBefore = await countsFor(FILE2);
    const fPlain = await realFetch(BASE + sharePath, { headers: { 'User-Agent': BROWSER_UA } });
    const fPlainBody = await fPlain.text();
    await sleep(400);
    const fAfter1 = await countsFor(FILE2);
    ok('分享链接真人拉取计一次', fAfter1 === fBefore + 1, `${fBefore} → ${fAfter1}`);

    const fTg = await realFetch(BASE + sharePath, { headers: { 'User-Agent': TG_UA } });
    const fTgBody = await fTg.text();
    await sleep(400);
    const fAfter2 = await countsFor(FILE2);
    ok('分享链接 TelegramBot 抓预览不计', fAfter2 === fAfter1, `${fAfter1} → ${fAfter2}`);
    ok(
        '分享通道 UA 也不影响内容',
        fPlain.status === 200 && fPlainBody.length > 0 && fTg.status === fPlain.status && fTgBody === fPlainBody,
        `HTTP ${fPlain.status}/${fTg.status} · ${fPlainBody.length}/${fTgBody.length} 字节`,
    );

    await api('DELETE', `/api/shares?code=${code}`);
}

// ---- 清理 ----
await api('DELETE', `/api/sub/${encodeURIComponent(SUB2)}`);
await api('DELETE', `/api/file/${encodeURIComponent(FILE2)}`);
const gone = await api('GET', '/api/subs');
ok('用例订阅已清理', !(gone.json?.data || []).some((s) => s.name === SUB2));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
