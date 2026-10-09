// 订阅编辑页布局回归：底部留白、两列底边对齐、节点内容编辑器可拉伸。
//
// 守的是一个很隐蔽的坑：
//   容器写的是 `p-6 md:p-10 ... pb-32`，但 Tailwind 把 `md:` 变体生成在基础工具类
//   **之后**，所以 `md:p-10` 的 padding-bottom（2.5rem = 40px）盖掉了裸写 `pb-32` 的
//   8rem。底部悬浮保存条高 63px —— 滚动到底时卡片底边距视口底只剩 40px，
//   **被压住 23px**，JSON 卡片的算子列表看不全。
//   修法是把留白也写成响应式变体（`md:pb-32`），同一条媒体查询里 pb 排在 p 之后。
//
// 用法：node scripts/verify-subedit-layout.mjs
// 前置：npm run dev:server（8795）+ npm run build
// 自带播种与清理：建一条本地订阅（15 个节点 + 5 个算子），收尾删除。

import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

const pwMod = await import(
    pathToFileURL(resolve(process.cwd(), 'apps/web/node_modules/playwright-core/index.js')).href
);
const chromium = pwMod.chromium || pwMod.default?.chromium;
const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const exe = join(root, readdirSync(root).find((d) => d.startsWith('chromium-')), 'chrome-win', 'chrome.exe');

const BASE =
    process.argv[2] || process.env.SUBPILOT_BASE || process.env.SPX_BASE || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';
const NAME = '_ui_check_layout';

// 用用户的视口尺寸：太高的视口内容放得下、根本不滚动，就测不出这个 bug
const VIEW = { width: 1320, height: 860 };

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
const api = (p, o = {}) => fetch(`${BASE}${p}`, { ...o, headers: { ...H, ...(o.headers || {}) } });

console.log(`\n== 订阅编辑页布局回归 @ ${BASE} ==\n`);

// ---- 播种：本地订阅，内容与算子都给足，保证右列高到需要滚动 ----
const NODES = Array.from(
    { length: 15 },
    (_, i) =>
        `vless://b9721119-7328-4c2a-842d-d4b6be797b28@192.168.${i + 1}.10:443?encryption=none&security=tls&sni=vpn.example.com&type=ws&host=vpn.example.com#节点${i + 1}`
).join('\n');
const PROCESS = [
    { type: 'Useless Filter', args: {} },
    { type: 'Regex Filter', args: { regex: ['广告'], mode: 'exclude' } },
    { type: 'Regex Rename', args: { regex: ['^[^|｜]*[|｜]\\s*', ''] } },
    { type: 'Flag Operator', args: { mode: 'add' } },
    { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
];

{
    const r = await api('/api/subs', {
        method: 'POST',
        body: JSON.stringify({ name: NAME, source: 'local', content: NODES, process: PROCESS }),
    });
    ok('播种本地订阅（15 节点 + 5 算子）', r.status === 201 || r.status === 200, `HTTP ${r.status}`);
}

const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: VIEW });
await ctx.addInitScript((t) => localStorage.setItem('sp_token', t), TOKEN);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
});

await page.goto(`${BASE}/#/subs/edit/${encodeURIComponent(NAME)}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const probe = () =>
    page.evaluate(() => {
        const box = (el) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
        };
        // 按标题文本定位 —— OperatorEditor 里的算子卡片也是 .card，
        // 用「最后一个 .card」会拿到算子卡片而不是 JSON 卡片。
        const all = [...document.querySelectorAll('main .card')];
        const pick = (kw) => all.find((c) => (c.innerText || '').trimStart().startsWith(kw));
        const bar = [...document.querySelectorAll('div')].find((d) => {
            const cs = getComputedStyle(d);
            return cs.position === 'fixed' && String(d.className).includes('border-t');
        });
        const main = document.querySelector('main');
        const ed = document.querySelector('.code-editor');
        return {
            viewportH: window.innerHeight,
            canScroll: main.scrollHeight > main.clientHeight,
            preview: box(pick('实时预览')),
            json: box(pick('JSON 脚本处理')),
            bar: box(bar),
            ed: ed
                ? { ...box(ed), resize: getComputedStyle(ed).resize }
                : null,
        };
    });

// ---- [1] 节点内容编辑器 ----
{
    const m = await probe();
    ok('节点内容编辑器已渲染', !!m.ed);
    ok('高度是 h-96（384px）', m.ed?.h === 384, `${m.ed?.h}px`);
    ok('computed resize = vertical（右下角可拉伸）', m.ed?.resize === 'vertical', m.ed?.resize);

    // 真拖一次，别只看 CSS 属性
    const box = await page.locator('.code-editor').first().boundingBox();
    const hx = box.x + box.width - 5;
    const hy = box.y + box.height - 5;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx, hy + 100, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.locator('.code-editor').first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
    ok('拖右下角真的能改变高度', after > 384 + 40, `384px → ${after}px`);
}

// ---- [2] 两列底边对齐（items-stretch） ----
{
    const m = await probe();
    ok(
        '预览卡与 JSON 卡底边对齐',
        Math.abs(m.preview.bottom - m.json.bottom) <= 1,
        `预览 ${m.preview.bottom} / JSON ${m.json.bottom}`
    );
}

// ---- [3] 核心：滚动到底，内容不能被底部悬浮条压住 ----
{
    const before = await probe();
    ok('页面确实需要滚动（否则测不出这个 bug）', before.canScroll, `内容 ${before.json.bottom} vs 视口 ${before.viewportH}`);

    await page.evaluate(() => {
        const main = document.querySelector('main');
        main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(400);

    const m = await probe();
    const gap = m.viewportH - m.json.bottom;
    console.log(`    滚到底：卡片底边 ${m.json.bottom} · 视口底 ${m.viewportH} · 悬浮条上沿 ${m.bar.top}（高 ${m.bar.h}）`);
    ok(
        'JSON 卡底边没被悬浮条压住',
        m.json.bottom <= m.bar.top,
        m.json.bottom > m.bar.top ? `被压 ${m.json.bottom - m.bar.top}px` : `余量 ${m.bar.top - m.json.bottom}px`
    );
    ok(
        '预览卡底边没被悬浮条压住',
        m.preview.bottom <= m.bar.top,
        m.preview.bottom > m.bar.top ? `被压 ${m.preview.bottom - m.bar.top}px` : `余量 ${m.bar.top - m.preview.bottom}px`
    );
    ok('底部留白 ≥ 悬浮条高度', gap >= m.bar.h, `留白 ${gap}px vs 悬浮条 ${m.bar.h}px`);
}

ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' || '));

// ---- 收尾 ----
await browser.close();
await api(`/api/sub/${encodeURIComponent(NAME)}`, { method: 'DELETE' });
const left = await (await api('/api/subs')).json();
ok('收尾：临时订阅已清理', !(left.data || []).some((s) => s.name === NAME));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
