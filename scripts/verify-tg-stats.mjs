// TG 推送不计入「分发统计」（2026-10-11）。
//
// 背景：TG 收到带链接的消息后会**自己去抓一次**那条地址做预览
// （telegram.js 的 sendMessage 传了 disable_web_page_preview: false），
// 那一跳会打进 /download 或 /share，于是概览页的「分发统计」里凭空多出一条
// TG 的拉取记录，看起来像有人真拉过这个订阅。
//
// 判据是**确定性的**：推送链接由 telegram.js 的 tgMarked() 打上 `src=tg`，
// convert.js 的 handleDownload / handleShare 见到标记就跳过 recordPull。
// 刻意不认 UA / 出口 IP —— UA 谁都能伪造、TG 网段也会变，认它们就是猜。
//
// 两段：
//   · 单元段 —— 内存 KV 起一份快照 + 把 globalThis.fetch 换成拦截器，
//     直接调 handleTelegram 的 /api/telegram/push，检查**真正发给 TG 的消息正文**里
//     链接带上了标记（订阅走 /download?ft=，文件/成品走 /share/…?code=），
//     并用 buildLinks 直出的链接做反面对照（不带标记 = 标记只加在推送这一路上）。
//   · HTTP 段 —— 打真实本地服务：同一条分发链接，普通拉取计一次，
//     带 src=tg 的拉取一次都不计；且带标记不改变响应内容。
//
// 用法：node scripts/verify-tg-stats.mjs [baseUrl]
// 需要先起本地服务：SUBPILOT_TOKEN=dev-local-token PORT=8795 node apps/server/node/server.mjs

const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════ [1] 单元：推送链接带标记
console.log('\n[1] 单元 · 推送给 TG 的链接带 src=tg 标记');

const { handleTelegram, tgMarked } = await import('../apps/server/src/telegram.js');
const { buildLinks } = await import('../apps/server/src/convert.js');

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
const snapshot = {
    app: 'SubPilot',
    version: 1,
    rev: 1,
    subs: [{ name: SUB, displayName: '示例订阅', source: 'remote', url: ['https://example.com/a'], process: [] }],
    collections: [],
    files: [{ name: FILE, displayName: '示例文件', source: 'local', content: 'hello' }],
    converted: [{ name: CONV, target: 'clash', content: 'proxies: []' }],
    shares: [],
    templates: [],
    settings: {
        // 固定对外基地址，让链接可预测（否则取请求来源）
        publicBaseUrl: 'https://sp.test',
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
const pushReq = new Request('https://sp.test/api/telegram/push', {
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
const convUrl = urls.find((u) => u.includes('/share/converted/')) || '';

const isMarked = (u) => {
    try {
        return new URL(u).searchParams.get('src') === 'tg';
    } catch {
        return false;
    }
};

ok('订阅推送链接带 src=tg', isMarked(subUrl), subUrl);
ok('文件推送链接带 src=tg', isMarked(fileUrl), fileUrl);
ok('成品推送链接带 src=tg', isMarked(convUrl), convUrl);
ok('订阅链接仍带派生密钥 ft=', /[?&]ft=[A-Za-z0-9_-]{16,}/.test(subUrl), subUrl);
ok('文件链接仍带分享码 code=', /[?&]code=[A-Za-z0-9_-]{10,}/.test(fileUrl), fileUrl);
ok('标记是独立查询参数，没把 ft / code 的值粘坏', isMarked(subUrl) && isMarked(fileUrl));

// 反面对照：buildLinks 直出的分发链接（前端「复制订阅」用的那条）**不带**标记 ——
// 证明标记只加在「推给 TG」这一路上，普通分发照旧计入统计。
const direct = await buildLinks({ url: 'https://sp.test/' }, env, snapshot, { kind: 'sub', name: SUB });
ok('反面对照：buildLinks 直出的分发链接不含 src', !/src=/.test(direct.link), direct.link);
ok('tgMarked 与直出链接只差这一个参数（逐字相同）', tgMarked(direct.link) === subUrl, `${direct.link}\n      → ${subUrl}`);

// 边界：没有查询串时用 ?，有时用 &
ok('tgMarked 对无查询串的地址用 ?', tgMarked('https://sp.test/x') === 'https://sp.test/x?src=tg', tgMarked('https://sp.test/x'));
ok('tgMarked 对空值原样返回', tgMarked('') === '');

// ══════════════════════════════════════════ [2] HTTP：带标记的拉取不计统计
console.log('\n[2] HTTP · 带 src=tg 的拉取不计入分发统计');

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

const plain = await realFetch(BASE + local);
const plainBody = await plain.text();
await sleep(400);
const afterPlain = await countsFor(SUB2);
ok('普通拉取计一次', afterPlain === before + 1, `${before} → ${afterPlain}`);

const marked = await realFetch(`${BASE}${local}&src=tg`);
const markedBody = await marked.text();
await sleep(400);
const afterMarked = await countsFor(SUB2);
ok('带 src=tg 的拉取一次都不计', afterMarked === afterPlain, `${afterPlain} → ${afterMarked}`);
ok(
    '带标记不影响分发本身（状态码与正文逐字相同）',
    plain.status === 200 && plainBody.length > 50 && marked.status === plain.status && markedBody === plainBody,
    `HTTP ${plain.status}/${marked.status} · ${plainBody.length}/${markedBody.length} 字节`,
);

// 再拉一次带标记的，确认不是「只跳过一次」
await (await realFetch(`${BASE}${local}&src=tg`)).text();
await sleep(400);
ok('连拉两次带标记也仍然不计', (await countsFor(SUB2)) === afterMarked, `仍为 ${afterMarked}`);

// ---- /share 通道（文件 / 成品）----
const FILE2 = '__verify_tgstats__.txt';
await api('DELETE', `/api/file/${encodeURIComponent(FILE2)}`);
await api('POST', '/api/files', { name: FILE2, source: 'local', content: 'hello tg' });
const sh = await api('POST', '/api/shares', { type: 'file', name: FILE2 });
const code = sh.json?.data?.code || '';
ok('建出文件分享码', !!code, `HTTP ${sh.status} code=${code}`);

if (code) {
    const sharePath = `/share/file/${encodeURIComponent(FILE2)}?code=${code}`;
    const fBefore = await countsFor(FILE2);
    const fPlain = await realFetch(BASE + sharePath);
    const fPlainBody = await fPlain.text();
    await sleep(400);
    const fAfter1 = await countsFor(FILE2);
    ok('分享链接普通拉取计一次', fAfter1 === fBefore + 1, `${fBefore} → ${fAfter1}`);

    const fMarked = await realFetch(`${BASE}${sharePath}&src=tg`);
    const fMarkedBody = await fMarked.text();
    await sleep(400);
    const fAfter2 = await countsFor(FILE2);
    ok('带 src=tg 的分享拉取不计', fAfter2 === fAfter1, `${fAfter1} → ${fAfter2}`);
    ok(
        '分享通道带标记也不影响内容',
        fPlain.status === 200 && fPlainBody.length > 0 && fMarked.status === fPlain.status && fMarkedBody === fPlainBody,
        `HTTP ${fPlain.status}/${fMarked.status} · ${fPlainBody.length}/${fMarkedBody.length} 字节`,
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
