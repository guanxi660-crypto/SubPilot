import { runScript, auditScriptCode, isScriptSupported } from '../src/scriptrun.js';

const helpers = { regionOf: () => 'US', flagOf: () => '🇺🇸', log: () => {} };
let pass = 0, fail = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS: ${name}`);
        pass++;
    } catch (e) {
        console.log(`  FAIL: ${name} — ${e.message}`);
        fail++;
    }
}

console.log('Test 0: isScriptSupported');
test('isScriptSupported 返回 true', () => {
    if (!isScriptSupported()) throw new Error('应返回 true');
});

console.log('Test 1: 新构造节点（无 raw/obj）改名不应崩溃');
test('新构造节点不崩溃', () => {
    const nodes = [{ id: 'a', format: 'uri', type: 'ss', name: 'old', raw: 'ss://abc#old' }];
    const code = '(nodes, h) => { const n = { id: "new", format: "uri", type: "ss", name: "brand-new" }; return [...nodes, n]; }';
    const result = runScript(code, nodes, helpers);
    if (result.length !== 2) throw new Error('应返回2个节点');
    if (result[1].name !== 'brand-new') throw new Error('新节点name不对');
});

console.log('Test 2: 已有节点改名 + 回写 raw');
test('改名回写raw', () => {
    const nodes = [{ id: 'a', format: 'uri', type: 'ss', name: 'old', raw: 'ss://abc#old' }];
    const code = '(nodes, h) => { nodes[0].name = "new-name"; return nodes; }';
    const result = runScript(code, nodes, helpers);
    if (!result[0].raw.includes('new-name')) throw new Error('raw未回写');
});

console.log('Test 3: helpers.rename 对已有节点改名');
test('helpers.rename回写', () => {
    const nodes = [{ id: 'a', format: 'uri', type: 'ss', name: 'old', raw: 'ss://abc#old' }];
    const code = '(nodes, h) => { h.rename(nodes[0], "renamed"); return nodes; }';
    const result = runScript(code, nodes, helpers);
    if (!result[0].raw.includes('renamed')) throw new Error('raw未回写');
});

console.log('Test 4: helpers.rename 对新构造节点改名（无 raw/obj）');
test('helpers.rename新节点', () => {
    const code = '(nodes, h) => { const n = { id: "x", format: "uri", type: "ss", name: "created" }; h.rename(n, "renamed2"); return [n]; }';
    const result = runScript(code, [], helpers);
    if (result[0].name !== 'renamed2') throw new Error('name不对');
});

console.log('Test 5: 过滤');
test('过滤', () => {
    const nodes = [
        { id: 'a', format: 'uri', type: 'ss', name: 'A', raw: 'ss://a#A' },
        { id: 'b', format: 'uri', type: 'ss', name: 'B', raw: 'ss://b#B' },
    ];
    const code = '(nodes) => nodes.filter(n => n.name === "B")';
    const result = runScript(code, nodes, helpers);
    if (result.length !== 1) throw new Error('过滤后应为1个');
});

console.log('Test 6: 危险 API 拦截');
test('审计拦截fetch', () => {
    const hits = auditScriptCode('fetch("http://evil.com")');
    if (hits.length === 0) throw new Error('应拦截fetch');
});

console.log('Test 7: 超时');
test('超时保护', () => {
    const code = '(nodes) => { while(true) {} return nodes; }';
    try {
        runScript(code, [], helpers);
        throw new Error('应该超时');
    } catch (e) {
        if (!/超时/.test(e.message)) throw e;
    }
});

console.log('Test 8: 非数组返回拒绝');
test('非数组拒绝', () => {
    const code = '(nodes) => 42';
    try {
        runScript(code, [], helpers);
        throw new Error('应该拒绝');
    } catch (e) {
        if (!/数组/.test(e.message)) throw e;
    }
});

console.log(`\n结果: ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);