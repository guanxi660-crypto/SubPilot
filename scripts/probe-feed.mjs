// 临时探针：确认「本地处理」路径下 SCE 输出里引用的是本站 feed 地址。
// 验证完可删。用法：node scripts/probe-feed.mjs

const BASE = 'http://127.0.0.1:8795';
const TOKEN = 'dev-local-token';
const NAME = 'probe1';

const content = Buffer.from(
    ['ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#香港 01', 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.5:8388#日本 01'].join('\n'),
    'utf8',
).toString('base64');

async function api(path, options = {}) {
    return fetch(`${BASE}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
    });
}

await api(`/api/sub/${NAME}`, { method: 'DELETE' }).catch(() => {});
await api('/api/subs', {
    method: 'POST',
    body: JSON.stringify({
        name: NAME,
        source: 'local',
        content,
        process: [{ type: 'Flag Operator', args: { mode: 'add' } }],
    }),
});

// 1) 本地处理路径
const clash = await fetch(`${BASE}/sub?target=clash&sub=${NAME}&token=${TOKEN}`);
const clashText = await clash.text();
console.log(`[clash] HTTP ${clash.status} · ${clashText.length} 字节 · processed=${clash.headers.get('X-SubPilot-Processed')}`);
const feedRefs = [...clashText.matchAll(/https?:\/\/[^\s"'<>]*\/feed\/[^\s"'<>]*/g)].map((m) => m[0]);
console.log(`  输出里引用的 feed 地址：${feedRefs.length ? feedRefs.join('\n    ') : '(无)'}`);
console.log(`  含 proxy-providers: ${/proxy-providers/.test(clashText)}`);
console.log('  --- 输出前 30 行 ---');
console.log(clashText.split('\n').slice(0, 30).map((l) => '  ' + l).join('\n'));

// 2) 直接取 feed，确认内容是可被 SCE 消费的节点列表
const feed = await fetch(`${BASE}/feed/sub/${NAME}?token=${TOKEN}`);
const feedText = await feed.text();
console.log(`\n[feed] HTTP ${feed.status} · ${feedText.length} 字节 · format=${feed.headers.get('X-SubPilot-Format')}`);
console.log('  解码后前 3 行：');
console.log(
    Buffer.from(feedText.trim(), 'base64')
        .toString('utf8')
        .split('\n')
        .slice(0, 3)
        .map((l) => '  ' + l)
        .join('\n'),
);

// 3) 另一个目标格式（非 Provider 模式），对照用
const alt = await fetch(`${BASE}/sub?target=shadowrocket&sub=${NAME}&token=${TOKEN}`);
const altText = await alt.text();
console.log(`\n[shadowrocket] HTTP ${alt.status} · ${altText.slice(0, 200)}`);

await api(`/api/sub/${NAME}`, { method: 'DELETE' });
