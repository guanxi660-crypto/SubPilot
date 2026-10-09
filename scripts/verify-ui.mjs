// 交互验证：地址栏回填、分享链接就地展开、未展开时不占版面。
// 依赖本地 dev 服务（8795）与已构建的前端产物。
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

const pwMod = await import(
    pathToFileURL(resolve(process.cwd(), 'apps/web/node_modules/playwright-core/index.js')).href
);
const chromium = pwMod.chromium || pwMod.default?.chromium;
const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const exe = join(root, readdirSync(root).find((d) => d.startsWith('chromium-')), 'chrome-win', 'chrome.exe');

const BASE = 'http://127.0.0.1:8795';
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(() => localStorage.setItem('sp_token', 'dev-local-token'));
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 带上 URL：只记一行文本时，「502」这种既可能是外部探活波动、也可能是本地接口挂了，
// 不记 URL 就只能猜。
page.on('console', (m) => {
    if (m.type() === 'error') {
        const url = m.location?.()?.url || '';
        errors.push(`${m.text().split('\n')[0]}${url ? ` @ ${url}` : ''}`);
    }
});

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
    ok ? pass++ : fail++;
};

// 记下开跑前已有的分享码。收尾时只删本次新增的 —— 用户可能真在用某条分享链接，
// 一把全删会把他的链接打挂（而且分享码是发给别人的，删了对方就断了）。
const sharesBefore = new Set(
    (
        await (
            await fetch(`${BASE}/api/shares`, { headers: { Authorization: 'Bearer dev-local-token' } })
        ).json()
    ).data?.map((s) => s.code) || [],
);

// ---- 1. 概览页：转换后端卡片的「配置」应跳去转换页，而不是设置页 ----
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
// 快捷入口三张列表卡已移除：各自有独立页面，概览只留统计数字与状态
// （这三条必须在跳走之前断言 —— 点了「配置」页面就已经不是概览了）
check('概览页「全部 ›」跳转链接已移除', (await page.locator('text=全部 ›').count()) === 0);
check('概览页不再出现列表空状态', (await page.locator('text=还没有订阅').count()) === 0);
check('概览页统计卡仍在（含转换后成品计数）', (await page.locator('text=转换快照').count()) === 1);
const cfgBtn = page.locator('button', { hasText: '配置' }).first();
check('概览页存在「转换后端 · 配置」按钮', (await cfgBtn.count()) > 0);
await cfgBtn.click();
await page.waitForTimeout(800);
const hashAfterCfg = page.url().split('#')[1] || '';
check('点「配置」跳到转换页（/converter）', hashAfterCfg.startsWith('/converter'), hashAfterCfg);

// ---- 2. 转换页：点击订阅源后地址栏应带上 sub 参数 ----
await page.goto(`${BASE}/#/converter`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// ---- 2a. 顶部三按钮工具条已移除，「转换」落进「转换后端」分区 ----
// 历史需求删掉了顶部工具条的「复制链接」；现在产出区有新的「⧉ 复制链接」
// （复制分发链接/转换直链），全文应恰好这一处。
check('「复制链接」只存在于产出区（恰好 1 处）', (await page.locator('button', { hasText: '复制链接' }).count()) === 1);
// 注意区分：工具条那个是「↗ 打开」，预览链接行的「打开 ↗」也已按需求删掉
check('顶部「↗ 打开」按钮已移除', (await page.locator('button', { hasText: '↗ 打开' }).count()) === 0);

// 转换后端已并入上方主卡片（参数上方）：同一张卡里应同时有「输入源」「转换后端」「参数」
const mainCard = page.locator('.card', { hasText: '输入源' }).first();
check('「转换后端」已并入输入源所在的卡片', (await mainCard.locator('text=转换后端').count()) > 0);
check('同一张卡里也有「参数」分区', (await mainCard.locator('text=参数').count()) > 0);
check('独立的「转换后端」卡片已不存在', (await page.locator('.card', { hasText: '转换后端地址' }).count()) === 1
    && (await page.locator('button', { hasText: '▶ 转换' }).count()) === 1);

const runBtn = mainCard.locator('button', { hasText: '▶ 转换' });
check('「转换」按钮在「转换后端」分区内', (await runBtn.count()) === 1);
check('「转换」按钮可见可用', await runBtn.isVisible());
// 链接框里的「复制 / 打开」已删 —— 产出区不再有重复按钮
check('链接框里的「打开 ↗」已移除', (await page.locator('button', { hasText: '打开 ↗' }).count()) === 0);
check('「默认外部配置（可选）」已移除', (await page.locator('text=默认外部配置').count()) === 0);

// ---- 2b. 参数默认折叠，且开关全部未勾选 ----
const flagBtn = page.locator('button', { hasText: '地区旗帜' }).first();
check('参数区默认折叠（开关不可见）', !(await flagBtn.isVisible()));
check('折叠时显示「全部默认」摘要', (await page.locator('text=全部默认').count()) > 0);

await page.locator('button', { hasText: '参数' }).first().click();
await page.waitForTimeout(400);
check('点「参数」后展开', await flagBtn.isVisible());

// 逐个开关看类名，比全局数 border-accent 更精确（订阅选择按钮也用同一个高亮类）
const TOGGLE_LABELS = [
    '地区旗帜', '强制 UDP', 'TCP Fast Open', '跳过证书验证', '按名称排序',
    '过滤失效节点', '名称追加类型', '仅节点列表', '展开规则集', 'classical Provider',
];
let toggleOn = 0;
for (const label of TOGGLE_LABELS) {
    const cls = (await page.locator('button', { hasText: label }).first().getAttribute('class')) || '';
    if (cls.includes('border-accent')) toggleOn += 1;
}
check('展开后没有任何开关处于勾选态', toggleOn === 0, `勾选数=${toggleOn}/${TOGGLE_LABELS.length}`);

const cfgSel = page.locator('select').filter({ hasText: '自定义地址' }).first();
check('外部配置下拉存在且默认选中「默认」', (await cfgSel.inputValue()) === '__default');
check(
    '外部配置提示附 Custom_OpenClash_Rules 仓库链接',
    (await page.locator('a[href*="Custom_OpenClash_Rules"]').count()) > 0
        && (await page.locator('code', { hasText: 'Custom_Clash.ini' }).count()) > 0,
);
const optCount = await cfgSel.locator('option').count();
check('外部配置含 SubPilot-Archive 全量预设', optCount > 100, `option=${optCount} 项`);

// 切到自定义应出现输入框，切回默认应消失
await cfgSel.selectOption('__custom');
await page.waitForTimeout(300);
check('选「自定义地址…」出现输入框', (await page.locator('input[placeholder="https://.../Custom_Clash.ini"]').count()) > 0);
// 输入框里应保留切换前的地址，方便在原预设上微调，而不是清空重敲
const customVal = await page.locator('input[placeholder="https://.../Custom_Clash.ini"]').first().inputValue();
check('自定义输入框保留了原地址', customVal.includes('Custom_Clash.ini'), customVal.slice(0, 60));
await page.screenshot({ path: 'shots/06d-转换-自定义配置.png' });

await cfgSel.selectOption('__default');
await page.waitForTimeout(300);
check('切回「默认」输入框消失', (await page.locator('input[placeholder="https://.../Custom_Clash.ini"]').count()) === 0);
await page.screenshot({ path: 'shots/06c-转换-参数展开.png' });

const urlBefore = page.url();

// 找到第一个「本站订阅 / 组合」按钮（带 ▤ 前缀）
const subBtn = page.locator('button', { hasText: '▤' }).first();
await subBtn.click();
await page.waitForTimeout(900);
const urlAfter = page.url();

check('点击订阅源后地址栏新增 sub 参数', /[?&]sub=/.test(urlAfter), urlAfter.split('#')[1] || urlAfter);
check('地址栏内容确实变了', urlAfter !== urlBefore);

// 再点一次应取消选择并移除参数
await subBtn.click();
await page.waitForTimeout(700);
check('取消选择后 sub 参数被移除', !/[?&]sub=/.test(page.url()), page.url().split('#')[1] || '');

// 改目标格式也应写入地址栏
await page.selectOption('select', { index: 1 }).catch(() => {});
await page.waitForTimeout(600);

// ---- 2b. 已在转换页时，外部改掉 query 也要回灌到界面 ----
// 这一条守的是一个真实缺陷：hash 路由下同路由不同 query 不会重新挂载组件，
// onMounted 不再执行 → 地址栏写着选了 A、界面却没选。
const firstSub = page.locator('button', { hasText: '▤' }).first();
const firstName = (await firstSub.innerText()).replace(/^▤\s*/, '').trim();
await page.goto(`${BASE}/#/converter?sub=${encodeURIComponent(firstName)}&target=clash`, {
    waitUntil: 'networkidle',
});
await page.waitForTimeout(1200);
const selCls = (await page.locator('button', { hasText: '▤' }).first().getAttribute('class')) || '';
check('同页改 query 后订阅被回灌为选中态', selCls.includes('border-accent'), `sub=${firstName}`);
check('回灌后地址栏仍保留该参数', /[?&]sub=/.test(page.url()), page.url().split('#')[1] || '');

// ---- 2c. 保存成品后，成品列表必须立刻出现新卡片 ----
// 回归的是真实 bug：保存成功只弹 toast，界面上毫无踪迹，概览的「全部 ›」
// 又跳回本页 —— 而本页以前根本没有列表。
const outCard = page.locator('.card', { hasText: '产出' }).first();
const beforeCards = await page
    .locator('.card', { hasText: '重存即更新内容' }).first()
    .locator('.bg-panel2').count();
await runBtn.click();
let convOk = false;
for (let i = 0; i < 24; i++) {
    if ((await outCard.locator('pre').count()) > 0) { convOk = true; break; }
    await page.waitForTimeout(500);
}
check('点「转换」后产出内容展示', convOk);
await page.locator('button', { hasText: '保存成品' }).first().click();
await page.waitForTimeout(600);
check('弹出「保存成品」弹窗', (await page.locator('text=成品保存的是').count()) === 1);
// 弹窗里的「保存」是它 .card 内唯一的 btn-primary
await page.locator('.fixed .card button.btn-primary', { hasText: '保存' }).click();
let savedOk = false;
for (let i = 0; i < 16; i++) {
    const n = await page.locator('.card', { hasText: '重存即更新内容' }).first().locator('.bg-panel2').count();
    if (n === beforeCards + 1) { savedOk = true; break; }
    await page.waitForTimeout(500);
}
check('保存成品后列表立刻出现新卡片', savedOk, `之前 ${beforeCards} 张`);
await page.screenshot({ path: 'shots/06e-转换-成品列表.png' });

// 清理刚保存的成品，避免测试残留；顺便验证删除真的生效
if (savedOk) {
    const cardsBox = page.locator('.card', { hasText: '重存即更新内容' }).first();
    page.once('dialog', (d) => d.accept());
    await cardsBox.locator('button', { hasText: '删除' }).first().click();
    let delOk = false;
    for (let i = 0; i < 12; i++) {
        const n = await cardsBox.locator('.bg-panel2').count();
        if (n === beforeCards) { delOk = true; break; }
        await page.waitForTimeout(500);
    }
    check('删除成品后列表同步更新', delOk, `${beforeCards + 1} → 恢复`);
}

// ---- 3. 文件页：生成链接 → 卡片下方就地出现链接；再点「分享链接」可收起 ----
await page.goto(`${BASE}/#/files`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// 底部那条「已发出的分享链接」列表卡片应该已经不存在了
const bottomCard = await page.locator('text=已发出的分享链接').count();
check('底部「已发出的分享链接」卡片已移除', bottomCard === 0);

// 每张文件卡片上都应同时有「生成链接」和「分享链接」两个按钮
const genBtns = await page.locator('button', { hasText: '生成链接' }).count();
const shareBtns = await page.locator('button', { hasText: '分享链接' }).count();
check('卡片上同时存在「生成链接」与「分享链接」按钮', genBtns > 0 && genBtns === shareBtns, `生成=${genBtns} 分享=${shareBtns}`);

// 初始状态下不应有任何展开的链接面板
const panelOpenBefore = await page.locator('text=/还没有分享链接|\\/share\\/file\\//').count();
check('初始不展开任何链接面板', panelOpenBefore === 0);

// 点「分享链接」→ 就地展开，出现提示或已有链接
await page.locator('button', { hasText: '分享链接' }).first().click();
await page.waitForTimeout(500);
const panelOpenAfter = await page.locator('text=/还没有分享链接|\\/share\\/file\\//').count();
check('点「分享链接」后卡片下方展开面板', panelOpenAfter > 0);
await page.screenshot({ path: 'shots/12-文件分享-展开面板.png' });

// 再点一次应收起
await page.locator('button', { hasText: '分享链接' }).first().click();
await page.waitForTimeout(500);
const panelClosed = await page.locator('text=/还没有分享链接|\\/share\\/file\\//').count();
check('再点「分享链接」面板收起', panelClosed === 0);

// ---- 4. 生成链接：弹窗应为纯生成表单，生成后自动展开面板 ----
await page.locator('button', { hasText: '生成链接' }).first().click();
await page.waitForTimeout(600);
const modalTitle = await page.locator('text=生成分享链接').count();
check('弹窗标题为「为「x」生成分享链接」', modalTitle > 0);
const hasOpenLink = await page.locator('a', { hasText: '打开' }).count();
check('弹窗内没有「打开」链接', hasOpenLink === 0);
const modalHasCopy = await page.locator('button', { hasText: '复制' }).count();
check('弹窗内没有复制按钮（复制移到卡片面板）', modalHasCopy === 0);
await page.screenshot({ path: 'shots/12-文件分享-生成弹窗.png' });

// 点弹窗里的「生成」——它是弹窗内唯一的 btn-primary
await page.locator('.card button.btn-primary', { hasText: '生成' }).last().click();
await page.waitForTimeout(1800);

const modalGone = await page.locator('text=生成后会显示在这张文件卡片的下方').count();
check('生成后弹窗自动关闭', modalGone === 0);

const linkShown = await page.locator('text=/\\/share\\/file\\//').count();
check('生成后链接直接出现在卡片下方', linkShown > 0);
const copyBtns = await page.locator('button', { hasText: '复制' }).count();
check('卡片面板内提供「复制」按钮', copyBtns > 0);
await page.screenshot({ path: 'shots/12-文件分享-已生成.png' });

// ---- 4b. 设置页：令牌卡片已移除（令牌由 Worker secret 固定，页面改不了它） ----
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1100);
check('设置页没有「访问令牌」输入卡', (await page.locator('text=这个值必须与 Worker').count()) === 0);
check('没有「随机生成」按钮', (await page.locator('button', { hasText: '随机生成' }).count()) === 0);
check('没有「保存并验证」按钮', (await page.locator('button', { hasText: '保存并验证' }).count()) === 0);
check('「关于」卡里保留退出登录', (await page.locator('button', { hasText: '退出登录' }).count()) === 1);
check('显示已登录状态（令牌打码）', /已登录 · .+….+/.test(await page.locator('text=/已登录|未登录/').first().innerText()));

// ---- 5. Telegram 推送：同步页卡片 ----
await page.goto(`${BASE}/#/sync`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);

const tgCard = page.locator('.card', { hasText: 'Telegram 推送' }).first();
check('同步页存在「Telegram 推送」卡片', (await tgCard.count()) === 1);
check('TG 卡片有 Bot Token 输入框', (await tgCard.locator('input[name="sp-tg-bot-token"]').count()) === 1);
check('TG 卡片有推送 ID 输入框', (await tgCard.locator('input[placeholder*="-1001234567890"]').count()) === 1);
check('TG 卡片有「保存配置」按钮', (await tgCard.locator('button', { hasText: '保存配置' }).count()) === 1);
check('TG 卡片有「测试推送」按钮', (await tgCard.locator('button', { hasText: '测试推送' }).count()) === 1);
check('TG 卡片有「立即推送」按钮', (await tgCard.locator('button', { hasText: '立即推送' }).count()) === 1);
check('TG 卡片有推送目标多选区', (await tgCard.locator('text=推送目标（可多选）').count()) === 1);
check('TG 卡片有「即时推送」开关', (await tgCard.locator('text=目标有变动时自动推送').count()) === 1);
check('TG 卡片有链接格式下拉', (await tgCard.locator('select').count()) >= 1);
// 未勾目标时禁用 —— 否则点下去只会弹「请至少选择一个目标」，白跑一趟。
// 先点「清空」再断言：本地 KV 里可能存着真实配置的推送目标，
// 不清的话这条断言会随状态飘（第一次踩到就是被真实配置绊的）。
const clearPicked = tgCard.locator('button', { hasText: '清空' });
if (await clearPicked.count()) {
    await clearPicked.first().click();
    await page.waitForTimeout(300);
}
check('未选目标时「立即推送」禁用', await tgCard.locator('button', { hasText: '立即推送' }).first().isDisabled());
await page.screenshot({ path: 'shots/13-同步-TG推送.png' });

// ---- 6. 订阅 / 组合 / 文件：每张卡片都要有 TG 按钮 ----
async function cardsHaveTg(hash, pageName, refText) {
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1100);
    const tg = await page.locator('button', { hasText: '✈ TG' }).count();
    const ref = await page.locator('button', { hasText: refText }).count();
    check(`${pageName}：每张卡片都有 TG 按钮`, tg > 0 && tg === ref, `TG=${tg} / ${refText}=${ref}`);
    return tg;
}
await cardsHaveTg('subs', '订阅页', '编辑');
await cardsHaveTg('collections', '组合页', '编辑');
await cardsHaveTg('files', '文件页', '分享链接');

// ---- 7. TG 按钮菜单：能跳去推送设置 ----
await page.goto(`${BASE}/#/subs`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.locator('button', { hasText: '✈ TG' }).first().click();
await page.waitForTimeout(700);
const menuPush = await page.locator('.n-dropdown-option', { hasText: '立即推送' }).count();
const menuCfg = await page.locator('.n-dropdown-option', { hasText: '推送设置' }).count();
check('TG 菜单含「立即推送」', menuPush > 0);
check('TG 菜单含「推送设置…」', menuCfg > 0);
await page.screenshot({ path: 'shots/13-订阅-TG菜单.png' });
await page.locator('.n-dropdown-option', { hasText: '推送设置' }).first().click();
await page.waitForTimeout(1000);
const hashTg = page.url().split('#')[1] || '';
check('点「推送设置…」跳到同步页', hashTg.startsWith('/sync'), hashTg);

// ---- 8. 亮色主题：amber 警示文字必须压深 ----
// 回归的是真实漏网：text-amber-300/90 这类带透明度的变体曾漏覆盖，
// 原始亮黄 #fcd34d 在浅底上只有 1.4:1。
// 靶子：同步页的「同一个访问令牌」警示（「预览链接（含管理令牌）」已在
// 成品分享链接改版时按需求隐藏，不能再用它当靶子）。
await page.goto(`${BASE}/#/sync`, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('sp_theme', 'light'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const amberEl = page.locator('span.text-amber-300\\/90', { hasText: '同一个访问令牌' }).first();
check('亮色下存在「同一个访问令牌」amber 警示文字', (await amberEl.count()) > 0);
const amberColor = await amberEl.evaluate((el) => getComputedStyle(el).color);
check(
    '亮色下 amber 警示文字已压深为 #8a5200',
    amberColor === 'rgb(138, 82, 0)',
    amberColor,
);
await page.evaluate(() => localStorage.setItem('sp_theme', 'dark'));

// ---- 8b. 亮色主题：emerald 反馈文字同样必须压深 ----
// 和上面 amber 是同一类漏网：覆盖清单里补了 emerald-300/80、emerald-400/80，
// 偏偏没有 emerald-300/90，而「探活成功（5296 ms）」等 5 处反馈文字用的就是它。
// 这里挂一个临时元素量计算色 —— 比数类名可靠，能同时抓住「漏覆盖」和「被别处反超」。
await page.evaluate(() => localStorage.setItem('sp_theme', 'light'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const emColor = await page.evaluate(() => {
    const d = document.createElement('span');
    d.className = 'text-emerald-300/90';
    d.textContent = 'x';
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
});
check('亮色下 emerald-300/90 已压深为 #0f7355', emColor === 'rgb(15, 115, 85)', emColor);
await page.evaluate(() => localStorage.setItem('sp_theme', 'dark'));

// ---- 9. 设置页：模型拉取结果改成传统下拉 ----
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
const aiCard = page.locator('.card', { hasText: 'AI 助手' }).first();
check('AI 卡片存在', (await aiCard.count()) === 1);
check('AI 卡片仍有「拉取」按钮', (await aiCard.locator('button', { hasText: '拉取' }).count()) === 1);
check('模型输入框保留（可手填）', (await aiCard.locator('input[placeholder="gpt-4o-mini"]').count()) === 1);
// 模型名与拉取结果已合并成一个控件：标签改「模型」，拉取结果挂 datalist
check('标签已由「模型名」改为「模型」', (await aiCard.locator('label', { hasText: /^模型$/ }).count()) === 1);
check('已无「模型名」标签', (await aiCard.locator('label', { hasText: /^模型名$/ }).count()) === 0);
check(
    '模型候选列表已改自绘面板（不再用原生 datalist，也无 ▾ 按钮）',
    (await aiCard.locator('input[list="ai-models"]').count()) === 0 &&
        (await aiCard.locator('button[title="从已拉取的模型里选"]').count()) === 0 &&
        (await aiCard.locator('[data-model-box] input[name="sp-ai-model"]').count()) === 1,
);
check('不再有独立的「可用模型」区', (await page.locator('text=可用模型').count()) === 0);

// ---- 9b. 反浏览器自动填充 ----
// 页面上只要有一个裸的 type="password"，Chrome 就把整页判成登录表单，把模型这类
// 普通文本框当「用户名」去填 —— 实测会弹出浏览器里存的其他站点的账号，
// 把 datalist 的模型列表整个盖掉。所以：
//   密码框 → autocomplete="new-password"（密码框上写 off 是无效的，Chrome 会忽略）
//   普通框 → autocomplete="off" + 明确的 name，切断「紧挨密码框=用户名」的猜测
const naked = (sel) =>
    page.evaluate(
        (s) =>
            [...document.querySelectorAll(s)]
                .filter((el) => !['off', 'new-password'].includes(el.getAttribute('autocomplete') || ''))
                .length,
        sel,
    );
check(
    '模型输入框默认只读（readonly-until-focus：Chrome 对只读字段不弹任何建议）',
    (await aiCard.locator('input[name="sp-ai-model"][readonly]').count()) === 1,
);
check(
    '模型输入框挂了各家密码管理器的忽略标记',
    (await aiCard.locator('input[data-1p-ignore][data-lpignore][data-bwignore][data-protonpass-ignore]').count()) >= 1,
);
// API Key 改成点击后才渲染密码框：页面上没有裸密码框，Chrome 的
// 「登录表单」页面级判定根本不启动 —— 比任何 autocomplete 取值都可靠。
check(
    'API Key 默认不渲染输入框（点击「点击修改」后才出现）',
    (await aiCard.locator('input[type="password"]').count()) === 0 &&
        (await aiCard.locator('[data-key-toggle]').count()) === 1,
);
const nakedSettings = await naked('input[type="password"]');
check('设置页没有未声明的密码框', nakedSettings === 0, `裸密码框=${nakedSettings}`);

// ---- 10. TG 推送目标：胶囊多选（对齐转换页「输入源」） ----
await page.goto(`${BASE}/#/sync`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

// 同步页三个密钥框（Gist PAT / WebDAV 应用密码 / TG Bot Token）已升级 v3 方案：
// type=text + -webkit-text-security:disc —— 页面上不应再有任何裸 type=password。
// 两张卡片按 provider 条件渲染，所以两边都切一遍再查。
for (const p of ['GitHub Gist', 'WebDAV']) {
    await page.locator('button', { hasText: p }).first().click();
    await page.waitForTimeout(400);
    const n = await naked('input[type="password"]');
    check(`同步页「${p}」下没有裸密码框（v3 text-security 方案）`, n === 0, `裸密码框=${n}`);
    if (p === 'GitHub Gist') {
        // Gist 卡片只在 provider === 'gist' 时渲染，必须在切过去的当轮查
        const gistTok = page.locator('input[name="sp-gist-token"]');
        check(
            'Gist Token 走 text + 圆点伪装（密码管理器不认它）',
            (await gistTok.count()) === 1
                && (await gistTok.getAttribute('type')) === 'text'
                && (await gistTok.getAttribute('data-1p-ignore')) === 'true',
        );
    }
}
const tgTok = page.locator('input[name="sp-tg-bot-token"]');
check(
    'TG Bot Token 同样走 v3 密钥框',
    (await tgTok.count()) === 1 && (await tgTok.getAttribute('type')) === 'text',
);
const tgCard2 = page.locator('.card', { hasText: 'Telegram 推送' }).first();
const pills = tgCard2.locator('button', { hasText: /^[▤⊕⧉]\s/ });
const pillCount = await pills.count();
check('TG 推送目标已改为胶囊按钮', pillCount > 0, `pills=${pillCount}`);
// 卡片里只剩「即时推送」那一个复选框，复选列表整体已下线
check(
    'TG 目标区不再用复选框列表',
    (await tgCard2.locator('input[type=checkbox]').count()) === 1,
    `checkbox=${await tgCard2.locator('input[type=checkbox]').count()}`,
);
// 胶囊要能真正切换选中态
const firstPill = pills.first();
const pillClsBefore = (await firstPill.getAttribute('class')) || '';
await firstPill.click();
await page.waitForTimeout(400);
const pillClsAfter = (await firstPill.getAttribute('class')) || '';
check(
    '点胶囊能切换选中态',
    pillClsBefore !== pillClsAfter,
    `${pillClsBefore.includes('border-accent')} → ${pillClsAfter.includes('border-accent')}`,
);

// ---- 11. AI 助手：提案区三个一次性按钮 ----
// 提案只能由真实模型产出，这里直接把一条带 proposal 的会话塞进 localStorage，
// 绕开模型调用，专测按钮逻辑本身。
//
// 用「演示机场 A」而不是列表第一个：列表首个是「合并用订阅」（remote，指向
// example.org），预览时后端会真去拉那个地址 → 拉不到 → 400。
// 「演示机场 A」是 local 订阅，节点内容内联在库里，预览不需要任何外部请求。
const LOCAL_SUB = '演示机场 A';
await page.goto(`${BASE}/#/ai`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
check(
    '本地订阅「演示机场 A」在来源下拉里',
    (await page.locator('select option', { hasText: LOCAL_SUB }).count()) > 0,
);
await page.evaluate((name) => {
    const rec = [
        {
            id: 'sverify',
            title: '验证会话',
            draft: [],
            updatedAt: Date.now(),
            messages: [
                { role: 'user', content: '帮我清理一下节点' },
                {
                    role: 'assistant',
                    content: '好的，这是提案',
                    proposal: [{ type: 'Useless Filter', args: {} }],
                },
            ],
        },
    ];
    localStorage.setItem(`sp_sessions:sub:${name}`, JSON.stringify(rec));
    localStorage.setItem('sp_chat_last', `sub:${name}`);
}, LOCAL_SUB);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
// 「预览」按钮已从对话框撤掉：左侧常驻实时预览面板自动跟着最新提案刷新
check('提案区不再有「预览」按钮', (await page.locator('button', { hasText: /^预览$/ }).count()) === 0);
check('左侧实时预览面板默认打开', (await page.locator('text=实时预览').count()) > 0);
await page.waitForTimeout(2500);
check('左栏预览列出的是节点名', (await page.locator('text=香港 01').count()) > 0);
check('预览按提案跑（顶部有提案标注）', (await page.locator('text=正在预览最新 AI 提案').count()) > 0);

// 收起 / 再展开（与「历史」按钮对应）
await page.locator('button', { hasText: '收起预览' }).first().click();
await page.waitForTimeout(400);
check('左栏可收起', (await page.locator('text=实时预览').count()) === 0);
await page.locator('button', { hasText: /^预览$/ }).first().click();
await page.waitForTimeout(600);
check('左栏可再展开', (await page.locator('text=实时预览').count()) > 0);

await page.locator('button', { hasText: '忽略' }).first().click();
await page.waitForTimeout(600);
check('点「忽略」后整组按钮消失', (await page.locator('button', { hasText: '忽略' }).count()) === 0);
check('点「忽略」后显示「已忽略」', (await page.locator('text=已忽略').count()) > 0);
// 精确匹配提案区的「保存」—— 右侧栏的「保存到来源」含子串但不是同一个按钮
check('「忽略」是一次性的（保存按钮也没了）', (await page.locator('button', { hasText: /^保存$/ }).count()) === 0);
// 提案被处理后，预览自动回落到草稿预览
await page.waitForTimeout(1500);
check('「忽略」后预览回落到草稿', (await page.locator('text=预览当前草稿算子链').count()) > 0);

// ---- 12. AI 助手：底部说明不再歧义 ----
// 旧文案「看不到完整节点列表（只给 60 个样例）」没解释 60 是什么，
// 新文案要把它讲成「只拿到前 60 个节点当样例」。
check('底部说明解释了「60 个样例」是什么', (await page.locator('text=前 60 个节点').count()) > 0);
check('底部已无歧义旧文案', (await page.locator('text=只给 60 个样例').count()) === 0);

// ---- 13. AI 助手：会话历史要标清「哪个来源 + 聊的什么 + 什么时候」 ----
// 第 11 节塞进去的那条会话此刻就在历史里。注意标题不是写进去的 '验证会话' ——
// persist() 会用「首条 user 消息前 24 字」重算，所以这里认的是那句提问。
const SESS_TITLE = '帮我清理一下节点';
const subLabel = (await page.locator('select option', { hasText: LOCAL_SUB }).first().innerText()).trim();
const histRow = page.locator('div.items-start', { hasText: SESS_TITLE }).first();
check('会话历史里有刚写入的那条', (await histRow.count()) > 0);
const histText = (await histRow.innerText()).replace(/\s+/g, ' ').trim();
check('历史条目显示来源显示名', histText.includes(subLabel), histText);
check('历史条目显示会话主题', histText.includes(SESS_TITLE), histText);
check('历史条目显示时间', /(今天|\d{1,2}\/\d{1,2})\s+\d{2}:\d{2}/.test(histText), histText);

// ---- 14. AI 助手：流式期间「发送」变「停止」，能中断会话 ----
// 真实模型调用又慢又不确定，这里把流式接口挂住不返回 —— 前端就停在
// 「正在回答」状态，正好用来验停止按钮的出现与中断效果。
await page.locator('button', { hasText: '＋ 新会话' }).click();
await page.waitForTimeout(300);
await page.route('**/ai/assistant/stream', () => new Promise(() => {}));
await page.locator('textarea').first().fill('测试中断');
await page.locator('button', { hasText: /^发送$/ }).first().click();
await page.waitForTimeout(1200);
check('流式期间出现「停止」按钮', (await page.locator('button', { hasText: /^停止$/ }).count()) === 1);
check('流式期间「发送」按钮消失', (await page.locator('button', { hasText: /^发送$/ }).count()) === 0);
await page.locator('button', { hasText: /^停止$/ }).first().click();
await page.waitForTimeout(1000);
check('点「停止」后恢复「发送」', (await page.locator('button', { hasText: /^发送$/ }).count()) === 1);
check('点「停止」后消息标记为已中断', (await page.locator('text=（已中断）').count()) > 0);
check('中断不报错（不出现「对话失败」）', (await page.locator('text=对话失败').count()) === 0);
await page.unroute('**/ai/assistant/stream');

// ---- 收尾：清掉本次验证新增的分享码 ----
// 不删的话每跑一次就多一条（7 天有效期），既占 900 条配额，
// 又会让 shots.mjs 的「非演示数据」守门把整轮截图拦下来。
// 只删新增的：开跑前就存在的分享码可能是用户在用的，不能碰。
const sharesNow = (
    await (
        await fetch(`${BASE}/api/shares`, { headers: { Authorization: 'Bearer dev-local-token' } })
    ).json()
).data || [];
const mine = sharesNow.filter((s) => !sharesBefore.has(s.code));
for (const s of mine) {
    await fetch(`${BASE}/api/shares?code=${encodeURIComponent(s.code)}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer dev-local-token' },
    });
}
console.log(`  ~ 清理本次验证新增的分享码 ${mine.length} 条（保留原有 ${sharesNow.length - mine.length} 条）`);

await browser.close();
console.log(`\n== 交互检查：${pass} 通过 / ${fail} 失败 ==`);
if (errors.length) {
    console.log('控制台错误：');
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ! ' + e);
}
process.exit(fail ? 1 : 0);
