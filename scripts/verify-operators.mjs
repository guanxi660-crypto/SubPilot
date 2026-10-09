// 算子单元验证：纯函数，不需起服务。
// 重点覆盖 Region Pin（新增）——它是 AI 助手「地区置顶」技能的底座，
// 曾因为缺这个算子，AI 只能用「加数字前缀 0 再排序」的改名技巧凑合。
import { applyOperators } from '../apps/server/src/operators.js';

let ok = 0;
let fail = 0;
const check = (name, cond, extra) => {
    if (cond) {
        ok++;
        console.log('  ✓', name);
    } else {
        fail++;
        console.log('  ✗', name, extra ?? '');
    }
};

const mk = (name, type = 'vmess') => ({ name, type, server: `${name}.example.com`, port: 443 });
const names = (r) => r.nodes.map((n) => n.name);
const run = (nodes, process) => applyOperators(nodes, JSON.parse(JSON.stringify(process)));

// 固定样本：SG / HK / JP / 未知地区各若干，乱序摆放
const SAMPLE = [
    mk('JP 东京 01'),
    mk('SG 新加坡 01'),
    mk('US 洛杉矶 01'),
    mk('HK 香港 01'),
    mk('vless SG-02'),
    mk('🇭🇰 HK 02'),
    mk('自建专线'), // regionOf 认不出
];

// ---- 1. 基本置顶：不改名、SG 全在最前、其余相对顺序保持 ----
{
    const r = run(SAMPLE, [{ type: 'Region Pin', args: { regions: ['SG'], position: 'top' } }]);
    const n = names(r);
    // 置顶会改变顺序，所以比「名字集合」（排序后比较），不比序列
    const setEq = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');
    check('置顶不改任何节点名（名字集合不变）', setEq(n, SAMPLE.map((x) => x.name)), n.join(','));
    check('SG 节点全部排最前', n.slice(0, 2).every((x) => /SG/i.test(x)), n.slice(0, 3).join(','));
    check('其余节点相对顺序不变', n.slice(2).join('|') === ['JP 东京 01', 'US 洛杉矶 01', 'HK 香港 01', '🇭🇰 HK 02', '自建专线'].join('|'), n.slice(2).join(','));
}

// ---- 2. regions 先后 = 优先级（稳定排序）----
{
    const r = run(SAMPLE, [{ type: 'Region Pin', args: { regions: ['HK', 'SG'], position: 'top' } }]);
    const n = names(r);
    check('多地区时先填的排更前', /HK/.test(n[0]) && /HK/.test(n[1]) && /SG/.test(n[2]) && /SG/.test(n[3]), n.slice(0, 4).join(','));
}

// ---- 3. bottom 沉底 ----
{
    const r = run(SAMPLE, [{ type: 'Region Pin', args: { regions: ['SG'], position: 'bottom' } }]);
    const n = names(r);
    check('bottom 把 SG 排最后', /SG/i.test(n[n.length - 1]) && /SG/i.test(n[n.length - 2]), n.slice(-3).join(','));
}

// ---- 4. 中文名 / 国旗都能识别 ----
{
    const r = run(SAMPLE, [{ type: 'Region Pin', args: { regions: ['HK'], position: 'top' } }]);
    const n = names(r);
    check('中文名「香港」与 🇭🇰 都被识别置顶', /香港/.test(n[0]) || /香港/.test(n[1]), n.slice(0, 2).join(','));
}

// ---- 5. 空 regions 原样返回 ----
{
    const r = run(SAMPLE, [{ type: 'Region Pin', args: {} }]);
    check('空 regions 不动列表', names(r).join('|') === SAMPLE.map((x) => x.name).join('|'));
}

// ---- 6. 组合：Sort 后再 Pin，SG 置顶且其余按地区 ----
{
    const r = run(
        SAMPLE,
        [
            { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
            { type: 'Region Pin', args: { regions: ['SG'], position: 'top' } },
        ],
    );
    const n = names(r);
    check('Sort→Pin 组合：SG 最前', /SG/i.test(n[0]), n.slice(0, 2).join(','));
    const tail = n.slice(1);
    check('其余节点按地区有序（HK 在 JP 前）', tail.findIndex((x) => /香港|HK/i.test(x)) < tail.findIndex((x) => /JP|东京/.test(x)), tail.join(','));
}

// ---- 7. 对照：改名类算子只动名字、不动顺序 ----
{
    const r = run(
        SAMPLE,
        [{ type: 'Regex Rename', args: { regex: ['^SG', '0SG'] } }],
    );
    const n = names(r);
    check('Regex Rename 改名不改序', n[1] === '0SG 新加坡 01' && n[0] === SAMPLE[0].name, n.slice(0, 2).join(','));
}

// ---- 8. 未知算子仍明确报日志（防回归）----
{
    const r = run(SAMPLE, [{ type: 'Script Operator', args: {} }]);
    check('Script Operator 明确报「不支持脚本」', r.log.some((l) => /不支持任意 JS 脚本/.test(l)), r.log.join(';'));
}

console.log(`\n== 算子验证：${ok} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
