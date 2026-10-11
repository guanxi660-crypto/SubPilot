import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const QuickJS = await getQuickJS();

const nodes = [{ id: 'a', name: '香港 01', format: 'uri', type: 'ss', raw: 'ss://a#hk' }];
const regions = JSON.stringify({ '香港': 'HK', '日本': 'JP', '台湾': 'TW', '新加坡': 'SG', '美国': 'US' });
const flags = JSON.stringify({ HK: '🇭🇰', JP: '🇯🇵', TW: '🇹🇼', SG: '🇸🇬', US: '🇺🇸' });

const userCode = `(nodes, h) => {
    var flag = h.flagOf(h.regionOf(nodes[0].name));
    h.rename(nodes[0], flag + ' ' + nodes[0].name);
    return nodes;
}`;

const wrapped = `
(function(nodes) {
    var regions = ${regions};
    var flags = ${flags};
    function regionOf(name) {
        for (var k in regions) { if (name.indexOf(k) >= 0) return regions[k]; }
        return '';
    }
    function flagOf(code) { return flags[code] || ''; }
    var h = {
        rename: function(node, name) { node.name = String(name || ''); return node; },
        regionOf: regionOf,
        flagOf: flagOf,
        log: function() {},
    };
    return (${userCode})(nodes, h);
})(JSON.parse(${JSON.stringify(JSON.stringify(nodes))}))
`;

const result = QuickJS.evalCode(wrapped, {
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 3000),
});
console.log('结果:', JSON.stringify(result));

// 测试超时
try {
    QuickJS.evalCode('while(true) {}', {
        shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 500),
    });
    console.log('超时: 未触发');
} catch (e) {
    console.log('超时:', e.name, e.message);
}

// 测试非数组返回
try {
    QuickJS.evalCode('42', {
        shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 3000),
    });
    console.log('非数组: 未拒绝');
} catch (e) {
    console.log('非数组: 拒绝', e.message);
}