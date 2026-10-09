// 校验本项目的远程配置预设与 SubPilot-Archive 逐字一致。
//
// 两边的默认模板必须相同 —— 否则用户在两个项目之间切换时，同一个订阅会得到
// 不同的策略组结构，看起来像「转换坏了」，实际只是模板不一样。
//
// 用法：node scripts/verify-presets.mjs [SubPilot-Archive 仓库路径]
// 也支持环境变量 SUBPILOT_ARCHIVE_PATH；都没给时按下面几个常见位置去找。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
    process.argv[2],
    process.env.SUBPILOT_ARCHIVE_PATH,
    resolve(import.meta.dirname, '../../SubPilot-Archive'),
    resolve(import.meta.dirname, '../SubPilot-Archive'),
].filter(Boolean);

const ours = resolve(import.meta.dirname, '../apps/web/src/utils/configPresets.js');
const subconv = 'apps/server/src/subconv/presets.js';
const theirs = CANDIDATES.map((p) => resolve(p, subconv)).find((p) => existsSync(p));

if (!theirs) {
    console.log('跳过：找不到 SubPilot-Archive 的 presets.js，试过：');
    for (const p of CANDIDATES) console.log('  - ' + resolve(p, subconv));
    console.log('\n如需校验，请传入仓库路径：node scripts/verify-presets.mjs /path/to/SubPilot-Archive');
    process.exit(0);
}
console.log(`对比对象：${theirs}\n`);

const A = await import(pathToFileURL(theirs).href);
const B = await import(pathToFileURL(ours).href);

const flat = (m) => m.CONFIG_PRESET_GROUPS.flatMap((g) => g.options.map((o) => ({ group: g.label, ...o })));
const a = flat(A);
const b = flat(B);

let fail = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
    if (!ok) fail += 1;
};

check('默认模板 URL 一致', A.DEFAULT_CONFIG_URL === B.DEFAULT_CONFIG_URL, B.DEFAULT_CONFIG_URL);
check('分组数量一致', A.CONFIG_PRESET_GROUPS.length === B.CONFIG_PRESET_GROUPS.length,
    `SubPilot-Archive=${A.CONFIG_PRESET_GROUPS.length} 本项目=${B.CONFIG_PRESET_GROUPS.length}`);
check('预设总条数一致', a.length === b.length, `SubPilot-Archive=${a.length} 本项目=${b.length}`);
check('分组顺序一致',
    JSON.stringify(A.CONFIG_PRESET_GROUPS.map((g) => g.label)) ===
        JSON.stringify(B.CONFIG_PRESET_GROUPS.map((g) => g.label)));

// 逐条比 group + name + url，同时也就校验了组内顺序
let diff = 0;
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || {};
    const y = b[i] || {};
    if (x.group !== y.group || x.name !== y.name || x.url !== y.url) {
        diff += 1;
        if (diff <= 5) {
            console.log(`    差异 #${i}\n      SubPilot-Archive: [${x.group}] ${x.name} -> ${x.url}\n      本项目  : [${y.group}] ${y.name} -> ${y.url}`);
        }
    }
}
check('每条预设的分组 / 名称 / URL / 顺序全部一致', diff === 0, diff ? `${diff} 处不同` : `${a.length} 条`);

console.log(`\n== 预设一致性：${fail ? `${fail} 项失败` : '全部通过'} ==`);
process.exit(fail ? 1 : 0);
