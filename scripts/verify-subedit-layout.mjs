// 订阅编辑页布局回归：默认一屏锁定、算子多时 JSON 卡自适应超屏、两列底边对齐、矮窗口优雅回退。
//
// 守的设计（2026-10 重构 + 0.1.1 自适应增强）：
//   编辑订阅是表单页，默认打开就该整页可见 —— 容器 min-h-full + flex-col，
//   网格 grow basis-0 吃掉剩余高度；节点内容编辑器 lg:flex-1 跟着窗口高度伸缩；
//   预览列表与 JSON 卡内部自己滚。
//
//   0.1.1 新语义：**没有/少算子时页面仍锁定一屏**；但加了脚本算子后 JSON 卡
//   允许自适应拉伸超过整屏（jsonFlexNone → lg:flex-none，高度=内容），此时：
//     - JSON 卡与预览列表都不再有内部滚动（内容完整展开）
//     - 页面整体滚动，两列底边依旧对齐（items-stretch）
//     - 底部悬浮条依旧不压内容
//   预览列表右下角有拖拽手柄（startPreviewResize），可手动顶高网格。
//
//   两个隐蔽的坑，改动时别踩：
//   1. flex-basis: 0%（flex-1 的写法）在**容器高度不定**（min-h-full）时按规范
//      退化为 content —— CodeMirror 的内容高度会把整页撑到 2000px+，一切自适应
//      全作废。必须用定长 basis（basis-0 = 0px）。
//   2. 网格的隐式 auto 行按内容的 max-content 撑高，min-h-0 切不断（那只是允许
//      收缩，行高照样按内容算）。必须显式 lg:grid-rows-[minmax(0,1fr)]。
//   3. JSON 自适应需求用**子元素求和**而非 scrollHeight —— 内容少于可视高时
//      scrollHeight 虚报为 clientHeight，删算子后缩不回去。
//
// 用法：node scripts/verify-subedit-layout.mjs
// 前置：npm run dev:server（8795）+ npm run build（构建后须重启服务，dist 有内存缓存）
// 自带播种与清理：两条本地订阅（无算子 / 5 算子，各 15 节点），收尾删除。

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
const NAME_PLAIN = '_ui_check_layout';
const NAME_OPS = '_ui_check_layout_ops';
const WIDTH = 1320;

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

// ---- 播种：两条本地订阅 ----
const NODES = Array.from(
    { length: 15 },
    (_, i) =>
        `vless://b9721119-7328-4c2a-842d-d4b6be797b28@192.168.${i + 1}.10:443?encryption=none&security=tls&sni=vpn.example.com&type=ws&host=vpn.example.com#节点${i + 1}`
).join('\n');
// 足量算子：JSON 卡内容需求会超过一屏阈值（682px），触发 jsonFlexNone
const PROCESS = [
    { type: 'Useless Filter', args: {} },
    { type: 'Regex Filter', args: { regex: ['广告'], mode: 'exclude' } },
    { type: 'Regex Rename', args: { regex: ['^[^|｜]*[|｜]\\s*', ''] } },
    { type: 'Flag Operator', args: { mode: 'add' } },
    { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
];

for (const [name, process] of [
    [NAME_PLAIN, []],
    [NAME_OPS, PROCESS],
]) {
    const r = await api('/api/subs', {
        method: 'POST',
        body: JSON.stringify({ name, source: 'local', content: NODES, process }),
    });
    ok(`播种 ${name}${process.length ? '（15 节点 + 5 算子）' : '（15 节点，无算子）'}`, r.status === 201 || r.status === 200, `HTTP ${r.status}`);
}

const browser = await chromium.launch({ executablePath: exe });
const errors = [];

// 每档视口独立 context，互不污染
async function probeAt(name, height, { scrollToBottom = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height } });
    await ctx.addInitScript((t) => localStorage.setItem('sp_token', t), TOKEN);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text().split('\n')[0]);
    });
    await page.goto(`${BASE}/#/subs/edit/${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    if (scrollToBottom) {
        await page.evaluate(() => {
            const main = document.querySelector('main');
            main.scrollTop = main.scrollHeight;
        });
        await page.waitForTimeout(400);
    }
    const m = await page.evaluate(() => {
        const box = (el) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
        };
        // OperatorEditor 里的算子卡片也是 .card，按标题文本定位才拿得到目标卡片
        const all = [...document.querySelectorAll('main .card')];
        const pick = (kw) => all.find((c) => (c.innerText || '').trimStart().startsWith(kw));
        const bar = [...document.querySelectorAll('div')].find((d) => {
            const cs = getComputedStyle(d);
            return cs.position === 'fixed' && String(d.className).includes('border-t');
        });
        const main = document.querySelector('main');
        const ed = document.querySelector('.code-editor');
        const spill = (el) => (el ? el.scrollHeight - el.clientHeight : 0);
        return {
            viewportH: window.innerHeight,
            canScroll: main.scrollHeight > main.clientHeight,
            overScroll: main.scrollHeight - main.clientHeight,
            preview: box(pick('实时预览')),
            json: box(pick('JSON 脚本处理')),
            info: box(pick('基本信息')),
            bar: box(bar),
            ed: ed ? box(ed) : null,
            spill: { info: spill(pick('基本信息')), json: spill(pick('JSON 脚本处理')), preview: spill(pick('实时预览')) },
        };
    });
    await ctx.close();
    return m;
}

// ---- [1] 无算子订阅 @860：整页锁定一屏，默认打开全部可见 ----
{
    const m = await probeAt(NAME_PLAIN, 860);
    console.log(`    无算子 @${WIDTH}x860：编辑器 ${m.ed?.h}px · JSON 卡 ${m.json.h}px · 超出 ${m.overScroll}px`);
    ok('节点内容编辑器已渲染', !!m.ed);
    ok('编辑器高度自适应（不再是写死的 384px）', m.ed && m.ed.h > 0 && m.ed.h < 384, `${m.ed?.h}px`);
    ok('无算子时页面不滚动（整页锁定一屏）', !m.canScroll, `超出 ${m.overScroll}px`);
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
    ok(
        '预览卡与 JSON 卡底边对齐（items-stretch）',
        Math.abs(m.preview.bottom - m.json.bottom) <= 1,
        `预览 ${m.preview.bottom} / JSON ${m.json.bottom}`
    );
    ok(
        '卡片内容没有溢出自己的盒子',
        m.spill.info <= 1 && m.spill.json <= 1 && m.spill.preview <= 1,
        `基本信息 ${m.spill.info} / JSON ${m.spill.json} / 预览 ${m.spill.preview}`
    );
}

// ---- [2] 无算子订阅 @1200：编辑器随视口高度伸缩 ----
{
    const tall = await probeAt(NAME_PLAIN, 1200);
    ok(
        '高视口下编辑器跟着变高（不再浪费空间）',
        tall.ed && tall.ed.h > 380,
        `860 高 → ${'见上'} · 1200 高 → ${tall.ed?.h}px`
    );
    ok('高视口下页面同样不滚动', !tall.canScroll, `超出 ${tall.overScroll}px`);
}

// ---- [3] 5 算子订阅 @860：JSON 卡自适应超屏属预期 ----
{
    const m = await probeAt(NAME_OPS, 860);
    console.log(`    5 算子 @${WIDTH}x860：页面超出 ${m.overScroll}px · JSON 卡 ${m.json.h}px · 底边 预览 ${m.preview.bottom} / JSON ${m.json.bottom}`);
    ok('有算子时页面允许滚动（JSON 卡自适应超屏）', m.canScroll && m.overScroll > 100, `超出 ${m.overScroll}px`);
    ok('JSON 卡完整展开、无内部滚动', m.spill.json <= 1, `内滚 ${m.spill.json}px`);
    ok('预览列表同样完整展开、无内部滚动', m.spill.preview <= 1, `内滚 ${m.spill.preview}px`);
    ok(
        '超屏后两列底边依旧对齐',
        Math.abs(m.preview.bottom - m.json.bottom) <= 1,
        `预览 ${m.preview.bottom} / JSON ${m.json.bottom}`
    );
    const bottom = await probeAt(NAME_OPS, 860, { scrollToBottom: true });
    ok(
        '超屏滚到底后 JSON 卡底边没被悬浮条压住',
        bottom.json.bottom <= bottom.bar.top,
        bottom.json.bottom > bottom.bar.top ? `被压 ${bottom.json.bottom - bottom.bar.top}px` : `余量 ${bottom.bar.top - bottom.json.bottom}px`
    );
}

// ---- [4] 矮窗口：优雅回退为页面滚动，内容不被压扁 ----
{
    const short = await probeAt(NAME_OPS, 600);
    console.log(`    5 算子 @${WIDTH}x600：页面超出 ${short.overScroll}px · 编辑器 ${short.ed?.h}px`);
    ok('矮窗口下页面恢复滚动（不硬塞）', short.canScroll, `超出 ${short.overScroll}px`);
    ok(
        '矮窗口下卡片内容同样不溢出',
        short.spill.info <= 1 && short.spill.json <= 1 && short.spill.preview <= 1,
        `基本信息 ${short.spill.info} / JSON ${short.spill.json} / 预览 ${short.spill.preview}`
    );
    const bottom = await probeAt(NAME_OPS, 600, { scrollToBottom: true });
    ok(
        '矮窗口滚到底后 JSON 卡底边没被悬浮条压住',
        bottom.json.bottom <= bottom.bar.top,
        bottom.json.bottom > bottom.bar.top ? `被压 ${bottom.json.bottom - bottom.bar.top}px` : `余量 ${bottom.bar.top - bottom.json.bottom}px`
    );
}

ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' || '));

// ---- 收尾 ----
await browser.close();
for (const name of [NAME_PLAIN, NAME_OPS]) {
    await api(`/api/sub/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
const left = await (await api('/api/subs')).json();
ok(
    '收尾：临时订阅已清理',
    !(left.data || []).some((s) => s.name === NAME_PLAIN || s.name === NAME_OPS)
);

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
