// 地区识别回归：国旗 / 排序 / 地区筛选三个算子共用 nodes.js 的 regionOf()。
//
// 这里曾经踩过一个很隐蔽的坑：短国家码（fi / nl / in …）用**裸子串**匹配，
// 而节点名里全是普通英文单词 ——
//   `FI.ulzix.Hetzner_Online` 的 "online" 含 "nl" → 芬兰节点挂上荷兰国旗 🇳🇱（真实案例）；
//   "Finland" 含 "fi"、"10in1" 含 "in"，同理全错。
// 修复：≤3 个字母的国家码改为「整词」匹配（两侧非字母才算边界）。
// 本文件把这些名字固化下来，防止后人把匹配改回裸子串。
//
// 用法：node scripts/verify-regions.mjs（纯函数，不起服务也能跑）

import { regionOf, REGIONS, flagOf } from '../apps/server/src/nodes.js';

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

console.log('\n== 地区识别回归 ==\n');

// ---- [1] 真实案例：FI 不能再被认成 NL ----
const CASES = [
    // —— 短码的「整词」边界 ——
    ['vless FI.ulzix.Hetzner_Online', 'FI', '用户报障的原例'],
    ['FI.ulzix.Hetzner_Online', 'FI', ''],
    ['NL-AMS-01', 'NL', '连字符是边界'],
    ['NL AMS 01', 'NL', '空格是边界'],
    ['US_2', 'US', '下划线是边界'],
    ['HK01', 'HK', '数字是边界'],
    ['us01.online.example', 'US', 'online 里的 nl 不应命中'],
    ['SG-10in1', 'SG', '10in1 里的 in 不应命中'],
    ['Hetzner Online DE', 'DE', '后面的 DE 才是地区'],
    // —— 单词内部不算边界 ——
    ['Finland-01', 'FI', 'Finland 里的 fi 不该让别的国家命中；fin 整词命中'],
    ['russia-01', 'RU', 'russia 里的 us 不该命中 US'],
    ['usb-stick', '', 'usb 里的 us 不该命中'],
    ['STAYHOME', '', 'stayhome 里的 ay…h 无关；不应误判'],
    ['npm install', '', 'install 里的 in 不该命中'],
    // —— 中文 / 旗帜 / 长词仍是子串匹配 ——
    ['香港 IEPL 01', 'HK', ''],
    ['TW 台北', 'TW', ''],
    ['上海->回国', 'CN', ''],
    ['japan tokyo 02', 'JP', ''],
    ['🇸🇬 狮城 03', 'SG', '旗帜本身也是关键词'],
];
for (const [name, want, note] of CASES) {
    const got = regionOf(name);
    ok(`${JSON.stringify(name)} → ${want || '(无)'}${note ? `（${note}）` : ''}`, got === want, `实得 ${got || '(无)'}`);
}

// ---- [2] 芬兰等新地区必须有正确的旗帜 ----
for (const code of ['FI', 'SE', 'NO', 'DK', 'IE', 'AT', 'PL', 'CZ', 'GR', 'RO', 'HU', 'UA', 'KZ', 'NZ', 'MX', 'AE', 'ZA', 'MO']) {
    const r = REGIONS.find((x) => x.code === code);
    ok(`地区表包含 ${code}`, !!r, r?.flag || '');
    if (r) ok(`${code} 的旗帜是 ${r.flag}`, flagOf(code) === r.flag);
}

// ---- [3] 地区码不得互相冲突：每个短码只能属于一个地区 ----
// 否则「最长优先」救不了 —— 两个地区同长，谁先谁赢，结果取决于数组顺序。
{
    const seen = new Map();
    const dup = [];
    for (const r of REGIONS) {
        for (const k of r.kw) {
            if (!/^[a-z]{1,3}$/.test(k)) continue;
            if (seen.has(k) && seen.get(k) !== r.code) dup.push(`${k}: ${seen.get(k)} vs ${r.code}`);
            else seen.set(k, r.code);
        }
    }
    ok('短国家码不重复登记', !dup.length, dup.join('；') || `${seen.size} 个码全唯一`);
}

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
