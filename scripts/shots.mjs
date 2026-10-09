// 界面截图验证：播种数据 → 逐页截图，用于人工核对与交付展示。
// 用法：node scripts/shots.mjs
// 依赖 playwright-core + 本机已缓存的 chromium（不额外下载浏览器）。

// playwright-core 是 --no-save 临时装的（只为本脚本服务，不进 package.json），
// 位置在 apps/web/node_modules 下。ESM 不认 NODE_PATH，所以按绝对路径动态导入。
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pwPath = resolve(process.cwd(), 'apps/web/node_modules/playwright-core/index.js');
const pwMod = await import(pathToFileURL(pwPath).href);
// playwright-core 是 CJS，动态 import 后命名导出在 .default 上
const chromium = pwMod.chromium || pwMod.default?.chromium;

const BASE = 'http://127.0.0.1:8795';
const TOKEN = 'dev-local-token';
const OUT = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');

// 找本机缓存的 chromium
function findChromium() {
    const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    if (!existsSync(root)) return null;
    const dir = readdirSync(root).find((d) => d.startsWith('chromium-'));
    if (!dir) return null;
    const exe = join(root, dir, 'chrome-win', 'chrome.exe');
    return existsSync(exe) ? exe : null;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');

const NODES_A = [
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#香港%2001',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.5:8388#日本%20东京%2001',
    'trojan://pass@5.6.7.8:443?sni=example.com#美国%20洛杉矶%2001',
    'vless://11111111-2222-3333-4444-555555555555@9.9.9.9:443?encryption=none#新加坡%2001',
    'hysteria2://pass@10.0.0.1:443#台湾%20台北%2001',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.9:8388#剩余流量：100GB',
    'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.10:8388#官网%20example.com',
];

const PROCESS = [
    { type: 'Useless Filter', args: {} },
    { type: 'Regex Filter', args: { regex: ['(?i)剩余|流量|官网'], mode: 'exclude' } },
    { type: 'Handle Duplicate', args: { action: 'rename' } },
    { type: 'Flag Operator', args: { mode: 'add' } },
    { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
];

async function api(path, options = {}) {
    const res = await fetch(`${BASE}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
            ...(options.headers || {}),
        },
    });
    return res.json().catch(() => ({}));
}

// ---- 演示数据白名单 + 清空守门 ----
// seed() 会先删光所有订阅 / 组合 / 文件 / 成品 / 分享码再播种。
// 这是为了截图干净（残留的测试条目会让人误判界面出问题），
// 但一旦库里混进了真实数据 —— 自己加的订阅、真在用的分享链接 ——
// 跑一次截图就全没了，而且没有回收站。
// 所以只允许清空「本脚本自己播种的那些」，发现陌生条目就拒绝执行。
const DEMO = {
    subs: ['演示机场 A', '演示机场 B', '合并用订阅'],
    collections: ['全部节点'],
    files: ['rules.yaml', 'template.ini'],
    converted: ['演示机场 A · Clash'],
};

async function guard() {
    if (process.env.SHOTS_FORCE === '1') return;
    const strangers = [];
    const collect = async (listPath, allowed) => {
        const res = await api(listPath);
        for (const it of res.data || []) {
            if (!allowed.includes(it.name)) strangers.push(`${listPath} · ${it.name}`);
        }
    };
    await collect('/api/subs', DEMO.subs);
    await collect('/api/collections', DEMO.collections);
    await collect('/api/files', DEMO.files);
    await collect('/api/converted', DEMO.converted);
    const shares = (await api('/api/shares')).data || [];
    for (const s of shares) strangers.push(`/api/shares · ${s.type}/${s.name}（${s.code.slice(0, 8)}…）`);

    if (strangers.length) {
        console.error('\n拒绝清空 —— 发现非演示数据：');
        for (const s of strangers.slice(0, 10)) console.error('  · ' + s);
        if (strangers.length > 10) console.error(`  · …另有 ${strangers.length - 10} 项`);
        console.error(`\n共 ${strangers.length} 项。本脚本会先删光资源再播种，`);
        console.error('确认要清空它们就设 SHOTS_FORCE=1 重跑：');
        console.error('  SHOTS_FORCE=1 node scripts/shots.mjs\n');
        process.exit(1);
    }
}

async function seed() {
    // 先清空全部资源再播种。
    // 脚本要能反复运行：上一轮遗留的测试数据（探针用的 __verify_sub__、临时订阅）
    // 会混进截图，让"外观验收"变成误判 —— 看到一堆陌生条目还以为界面出了问题。
    const wipe = async (listPath, itemPath) => {
        const res = await api(listPath);
        for (const it of res.data || []) {
            await api(`${itemPath}/${encodeURIComponent(it.name)}`, { method: 'DELETE' }).catch(() => {});
        }
    };
    await wipe('/api/subs', '/api/sub');
    await wipe('/api/collections', '/api/collection');
    await wipe('/api/files', '/api/file');
    await wipe('/api/converted', '/api/converted');
    for (const s of (await api('/api/shares')).data || []) {
        await api(`/api/shares?code=${encodeURIComponent(s.code)}`, { method: 'DELETE' }).catch(() => {});
    }
    await api('/api/stats', { method: 'DELETE' }).catch(() => {});

    await api('/api/subs', {
        method: 'POST',
        body: JSON.stringify({
            name: '演示机场 A',
            displayName: '演示机场 A',
            source: 'local',
            content: b64(NODES_A.join('\n')),
            process: PROCESS,
        }),
    });
    await api('/api/subs', {
        method: 'POST',
        body: JSON.stringify({
            name: '演示机场 B',
            displayName: '演示机场 B（远程）',
            source: 'remote',
            url: 'https://example.com/api/v1/client/subscribe?token=demo',
            ua: 'clash-verge/v2.0',
            process: [{ type: 'Region Filter', args: { regions: ['HK', 'JP', 'US'], mode: 'keep' } }],
        }),
    });
    await api('/api/subs', {
        method: 'POST',
        body: JSON.stringify({
            name: '合并用订阅',
            displayName: '合并用订阅',
            source: 'remote',
            url: 'https://example.org/sub',
        }),
    });
    await api('/api/collections', {
        method: 'POST',
        body: JSON.stringify({
            name: '全部节点',
            displayName: '全部节点（港日美新）',
            subscriptions: ['演示机场 A', '演示机场 B'],
            process: [{ type: 'Limit Operator', args: { limit: 50, from: 'head' } }],
        }),
    });
    for (const [n, c] of [
        ['rules.yaml', 'rules:\n  - DOMAIN-SUFFIX,example.com,DIRECT\n'],
        ['template.ini', '[custom]\nemoji=true\n'],
    ]) {
        await api('/api/files', { method: 'POST', body: JSON.stringify({ name: n, source: 'local', content: c }) });
    }
    // 造一份成品，让概览页「成品」卡片与转换页有内容可看（否则永远是空态）
    await api('/api/converted', {
        method: 'POST',
        body: JSON.stringify({
            name: '演示机场 A · Clash',
            target: 'clash',
            template: '',
            content: 'port: 7890\nsocks-port: 7891\nallow-lan: true\nmode: rule\nlog-level: info\n',
        }),
    });
}

const PAGES = [
    { hash: '#/', name: '01-概览' },
    { hash: '#/subs', name: '02-订阅' },
    { hash: '#/subs/edit/%E6%BC%94%E7%A4%BA%E6%9C%BA%E5%9C%BA%20A', name: '03-订阅编辑' },
    { hash: '#/collections', name: '04-组合' },
    { hash: '#/files', name: '05-文件' },
    // 转换页要等一次真实的 SCE 探活往返（冷启动 1s+），否则会截到「检测中…」的中间态
    { hash: '#/converter', name: '06-转换', wait: 3000 },
    // 带 query 进页面：验证「选择同步到地址栏」能被正确恢复
    { hash: '#/converter?sub=%E6%BC%94%E7%A4%BA%E6%9C%BA%E5%9C%BA%20A&target=clash', name: '06b-转换-带参数', wait: 3000 },
    { hash: '#/sync', name: '07-同步' },
    { hash: '#/ai', name: '08-AI助手' },
    { hash: '#/settings', name: '09-设置' },
];

async function main() {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    await guard();
    await seed();

    const exe = findChromium();
    if (!exe) {
        console.error('找不到本机 chromium，跳过截图');
        process.exit(0);
    }

    const browser = await chromium.launch({ executablePath: exe });
    const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 2,
    });
    // 先注入令牌，避免每次都走登录页
    await ctx.addInitScript((t) => {
        localStorage.setItem('sp_token', t);
    }, TOKEN);

    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

    for (const p of PAGES) {
        const before = errors.length;
        await page.goto(`${BASE}/${p.hash}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(p.wait ?? 1200);
        await page.screenshot({ path: join(OUT, `${p.name}.png`), fullPage: false });
        // 按页归因：控制台报错时标出是哪个页面，比最后统一打印一堆堆栈有用得多
        const own = errors.slice(before);
        console.log(`  ${own.length ? '✗' : '✓'} ${p.name}${own.length ? '  → ' + own[0].split('\n')[0] : ''}`);
    }

    // 三种主题各来一张，确认配色切换真的生效。
    // 注意默认主题是 glass（深色调），而 headless 里 prefers-color-scheme 是 light，
    // 首访初值会落到 light —— 所以必须逐个显式写入，否则截出来几张会一模一样。
    //
    // 还必须用 reload 而不是 goto：当前 URL 已经是 `/#/`，再 goto 同一个地址
    // （仅 hash 不同）浏览器不会重新加载文档，主题模块也就不会重新读 localStorage，
    // 结果是三张图完全相同 —— 看起来像主题坏了，其实只是没刷新。
    const THEMES = [
        ['light', '亮色'],
        ['dark', '暗色'],
        ['glass', '玻璃'],
    ];
    for (const [mode, label] of THEMES) {
        const before = errors.length;
        await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
        await page.evaluate((m) => localStorage.setItem('sp_theme', m), mode);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(OUT, `11-概览-${label}.png`) });
        const own = errors.slice(before);
        console.log(`  ${own.length ? '✗' : '✓'} 11-概览-${label}${own.length ? '  → ' + own[0].split('\n')[0] : ''}`);
    }

    // 额外主题截图（发布项目时当展示图用）。
    // 概览页偏统计数字，订阅页才看得出卡片 / 列表在玻璃主题下的质感，
    // 所以这里单独补一张订阅页的玻璃主题。要加别的页面往 EXTRA 里塞一行即可。
    //
    // hash 字段自带 `#`，拼 URL 时是 `${BASE}/${hash}` —— 别写成 `${BASE}/#${hash}`，
    // 那样会得到 `##/subs`，Vue Router 认不出来就回落到概览页，
    // 截出来的图跟概览那张一模一样（md5 相同，很容易被当成「主题没生效」）。
    const EXTRA = [{ hash: '#/subs', mode: 'glass', name: '11-订阅-玻璃' }];
    for (const ex of EXTRA) {
        const before = errors.length;
        await page.goto(`${BASE}/${ex.hash}`, { waitUntil: 'networkidle' });
        await page.evaluate((m) => localStorage.setItem('sp_theme', m), ex.mode);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: join(OUT, `${ex.name}.png`) });
        const own = errors.slice(before);
        console.log(`  ${own.length ? '✗' : '✓'} ${ex.name}${own.length ? '  → ' + own[0].split('\n')[0] : ''}`);
    }

    // 防呆：额外截图不能和同主题的概览图字节相同。
    // 「hash 拼错 → 路由回落概览 → 两张图一模一样」不会抛任何错误，
    // 只能靠比对内容发现 —— 这次就是 md5 撞上才抓到的。
    let duplicated = false;
    for (const ex of EXTRA) {
        const themeLabel = THEMES.find(([m]) => m === ex.mode)?.[1] || '';
        const a = join(OUT, `${ex.name}.png`);
        const b = join(OUT, `11-概览-${themeLabel}.png`);
        if (existsSync(a) && existsSync(b) && md5(a) === md5(b)) {
            console.log(`  ✗ ${ex.name} 与「11-概览-${themeLabel}」内容完全相同 —— 路由多半没切过去`);
            duplicated = true;
        }
    }
    if (duplicated) process.exitCode = 1;

    // 截图后把主题恢复成默认（glass），免得后面手动开着浏览器时看到的是上一轮的残留主题
    await page.evaluate(() => localStorage.setItem('sp_theme', 'glass'));

    await browser.close();

    const total = PAGES.length + THEMES.length + EXTRA.length;
    if (errors.length) {
        console.log('\n控制台错误：');
        for (const e of [...new Set(errors)].slice(0, 20)) console.log('  ! ' + e);
    }
    if (errors.length || duplicated) {
        console.log(
            `\n== 界面检查：${total} 张，${new Set(errors).size} 类错误${duplicated ? '，有重复截图' : ''} ==`,
        );
    } else {
        console.log(`\n== 界面检查：${total} 张全部通过，无控制台错误 ==`);
    }
    console.log(`截图目录：${OUT}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
