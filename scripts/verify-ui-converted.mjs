// 转换页界面回归：分发链接区（含多来源）+ 成品卡的固定分享链接。
//
// 覆盖三件容易回归的事：
//   ① 「预览链接（含管理令牌）」不再出现在页面上 —— 它是排障用的，摆出来容易被误外发；
//   ② 多选来源时「分发链接」**不能**消失 —— 以前前端直接清空，用户手里只剩带令牌的链接；
//   ③ 成品卡的固定分享链接直接内联显示，没有「生成链接」按钮。
//
// 用法：node scripts/verify-ui-converted.mjs
// 前置：npm run dev:server（8795）+ npm run build（产物由 Worker 的 ASSETS 提供）
//
// 自带播种与清理：建一条成品 + 两条远程订阅，收尾全部删除。
// 订阅是必需的 —— 「多选时分发链接不消失」这条断言要求页面上至少有两个来源可选。

import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

const pwMod = await import(
    pathToFileURL(resolve(process.cwd(), 'apps/web/node_modules/playwright-core/index.js')).href
);
const chromium = pwMod.chromium || pwMod.default?.chromium;
const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const exe = join(root, readdirSync(root).find((d) => d.startsWith('chromium-')), 'chrome-win', 'chrome.exe');

// 与其它回归脚本保持一致：位置参数优先，其次环境变量。
// SUBPILOT_BASE 是正式名；SPX_BASE 是改名前的遗留名，保留兼容不删。
const BASE =
    process.argv[2] || process.env.SUBPILOT_BASE || process.env.SPX_BASE || 'http://127.0.0.1:8795';
const TOKEN = process.env.SPX_TOKEN || 'dev-local-token';
const NAME = '_ui_check_conv';

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

console.log(`\n== 转换页界面回归 @ ${BASE} ==\n`);

// ---- 播种 ----
// 一条成品（后端会自动给它建固定分享码）+ 两条**远程**订阅。
//
// 订阅是为了让下面的多选断言总能执行：它原先依赖「库里恰好有 ≥2 条远程订阅」，
// 干净环境上会整段跳过 —— 而「多选时分发链接消失」恰恰是本脚本要守的最容易回归的一条。
// 名字用 `__verify__` 风格的前缀，且收尾会删掉。
const SUB_A = '_ui_check_conv_a';
const SUB_B = '_ui_check_conv_b';
for (const name of [SUB_A, SUB_B]) {
    const r = await api('/api/subs', {
        method: 'POST',
        body: JSON.stringify({ name, source: 'remote', url: `https://example.com/${name}.txt` }),
    });
    ok(`播种远程订阅 ${name}`, r.status === 201 || r.status === 200, `HTTP ${r.status}`);
}

await api('/api/converted', {
    method: 'POST',
    body: JSON.stringify({
        name: NAME,
        target: 'clash',
        template: '',
        content: 'proxies:\n  - {name: "UI-CANARY", type: vmess, server: ui.example.com, port: 443, uuid: 11111111-1111-1111-1111-111111111111, alterId: 0, cipher: auto}\n',
    }),
});

const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addInitScript((t) => localStorage.setItem('sp_token', t), TOKEN);
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text().split('\n')[0]} @ ${m.location?.()?.url || ''}`);
});

// 本站是 hash 路由：/converter 会被 SPA 回退到首页，必须写 /#/converter
await page.goto(`${BASE}/#/converter`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

const body = () => page.locator('body').innerText();

// ---- [1] 预览链接不再展示 ----
ok('页面不再出现「预览链接（含管理令牌…）」', !(await body()).includes('含管理令牌'));
ok('页面不再出现「仅本机排障用」', !(await body()).includes('仅本机排障用'));
// 分发链接区是「有可用链接才显示」的 —— 刚进页面什么都没选，本就该是隐藏的
ok('未选来源时分发链接区隐藏', !(await body()).includes('分发链接（带派生只读密钥'));

// ---- [2] 多选来源时分发链接不能消失 ----
// 订阅卡是「输入源」模块里的胶囊按钮，文本就是订阅名。
async function pick(name) {
    await page.locator('button', { hasText: name }).first().click();
    await page.waitForTimeout(900);
}
// 播种时已建好这两条；仍回读一次，播种失败时走下面的 else 分支，
// 而不是拿不到名字就去点按钮、报出一堆误导性的失败。
const subNames = ((await (await api('/api/subs')).json()).data || [])
    .filter((s) => s.source === 'remote' && (s.name === SUB_A || s.name === SUB_B))
    .map((s) => s.name);
if (subNames.length >= 2) {
    await pick(subNames[0]);
    const withOne = await body();
    ok('单选时分发链接出现', withOne.includes('分发链接（带派生只读密钥'), '');
    ok('单选时 feed 行出现', /feed：http/.test(withOne));

    await pick(subNames[1]);
    const withTwo = await body();
    ok('多选时分发链接不消失', withTwo.includes('分发链接（带派生只读密钥'), '');
    ok('多选时链接仍不含管理令牌', !/token=/.test(withTwo.match(/分发链接[^\n]*\n([^\n]+)/)?.[1] || ''));
    ok('多选时 feed 行仍在', /feed：http/.test(withTwo));

    // 清掉选择，回到空态
    await pick(subNames[0]);
    await pick(subNames[1]);
    await page.waitForTimeout(600);
} else {
    console.log('  ~ 远程订阅不足 2 条，跳过多选分发链接断言');
}

// ---- [3] 成品卡：分享链接按钮化（与订阅卡片操作行对齐）----
const card = page.locator('div.bg-panel2').filter({ hasText: NAME }).first();
ok('成品卡片已渲染', (await card.count()) > 0);
if (await card.count()) {
    const flat = (await card.locator('button').allInnerTexts()).map((t) => t.trim()).join(' | ');
    ok('卡片不再有「生成链接」按钮', !flat.includes('生成链接'), flat);
    ok('卡片有「分享链接」按钮（在 TG 按钮旁）', flat.includes('分享链接'));
    ok('卡片仍有「✈ TG」', flat.includes('TG'));
    ok('卡片仍有「⤓ 下载」', flat.includes('下载'));
    ok('卡片仍有「删除」', flat.includes('删除'));

    // 点「分享链接」真的把 /share/converted 链接放进剪贴板
    await card.locator('button', { hasText: '分享链接' }).first().click();
    await page.waitForTimeout(400);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    ok('复制的是 /share/converted 完整链接', /\/share\/converted\/.+\?code=.+/.test(clip), clip.slice(0, 60) + '…');
}

// ---- 收尾：删成品（后端连带回收它的分享码）+ 删播种的订阅 ----
await browser.close();
await api(`/api/converted/${encodeURIComponent(NAME)}`, { method: 'DELETE' });
for (const name of [SUB_A, SUB_B]) {
    await api(`/api/sub/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

const left = await (await api('/api/shares')).json();
const stray = (left.data || []).filter((s) => s.name === NAME);
ok('收尾：成品与分享码已清理', stray.length === 0, stray.length ? JSON.stringify(stray) : '已清空');

const subsLeft = await (await api('/api/subs')).json();
ok(
    '收尾：播种的订阅已清理',
    !(subsLeft.data || []).some((s) => s.name === SUB_A || s.name === SUB_B)
);

ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' || '));

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
