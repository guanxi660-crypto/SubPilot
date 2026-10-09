// 只截 AI 助手页 —— 不走 shots.mjs 的「清库播种」流程（dev 库里有用户真实数据，不能清）。
// 会话历史是 localStorage 里的东西，在浏览器侧造几条即可，不碰服务端。
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem('sp_token', 'dev-local-token'));
const page = await ctx.newPage();

await page.goto(`${BASE}/#/ai`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 造三条会话，用来展示「来源显示名 + 会话主题 + 时间」三行格式与跨来源汇总
const SUB = await page.locator('select option').nth(1).getAttribute('value');
const COL = await page.locator('select optgroup[label="组合"] option').first().getAttribute('value');
await page.evaluate(
    ([sub, col]) => {
        const now = Date.now();
        const mk = (id, title, min, messages) => ({
            id,
            title,
            messages,
            draft: [],
            updatedAt: now - min * 60000,
        });
        localStorage.setItem(
            `sp_sessions:${sub}`,
            JSON.stringify([
                mk('d1', '删掉剩余流量和官网这类假节点，按地区排序', 3, [
                    { role: 'user', content: '删掉剩余流量和官网这类假节点，按地区排序' },
                    { role: 'assistant', content: '好的，先清无效节点再按地区排。', proposal: [
                        { type: 'Useless Filter', args: {} },
                        { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
                    ] },
                ]),
                mk('d2', '把所有节点加上国旗', 240, [{ role: 'user', content: '把所有节点加上国旗' }]),
            ]),
        );
        if (col) {
            localStorage.setItem(
                `sp_sessions:${col}`,
                JSON.stringify([mk('d3', '只保留港台日新美', 1500, [{ role: 'user', content: '只保留港台日新美' }])]),
            );
        }
        localStorage.setItem('sp_chat_last', sub);
    },
    [SUB, COL],
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2200);

await page.screenshot({ path: 'shots/08-AI助手.png' });
console.log('已更新 shots/08-AI助手.png');
await browser.close();
