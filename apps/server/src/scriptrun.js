// Script Operator 执行沙箱（Worker 版，QuickJS WASM）。
//
// Cloudflare Workers 禁 eval / new Function / node:vm，但允许 WebAssembly。
// quickjs-emscripten 把 QuickJS 编译成 WASM，在 Worker 里提供完整的 JS 解释器，
// 天然沙箱隔离（WASM 模块与宿主完全隔离），支持超时中断。
//
// 安全三层：
//   ① 静态黑名单审计（fetch / require / process … 命中即拒）
//   ② QuickJS WASM 沙箱隔离（不注入任何 host 全局，只有节点数组 + 白名单 helpers）
//   ③ 硬限制（脚本超时、节点上限、返回必须是数组）
//
// 执行方式：用 evalCode 把用户脚本 + nodes 数据 + regionOf/flagOf 映射表
// 合成一段代码，QuickJS 通过 JSON 序列化返回结果，无需手动管理 handle。

import { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { renameNode, REGIONS } from './nodes.js';

const SCRIPT_TIMEOUT_MS = 3000;
const SCRIPT_MAX_CODE_LEN = 20000;

let quickjsModule = null;
let wasmModulePromise = null;

async function getWasmModule() {
    if (!wasmModulePromise) {
        wasmModulePromise = (async () => {
            try {
                const mod = await import('./quickjs.wasm');
                return mod.default;
            } catch {
                const fs = await import('node:fs');
                const { fileURLToPath } = await import('node:url');
                const wasmPath = fileURLToPath(new URL('./quickjs.wasm', import.meta.url));
                const wasmBuffer = fs.readFileSync(wasmPath);
                return await WebAssembly.compile(wasmBuffer);
            }
        })();
    }
    return wasmModulePromise;
}

async function getModule() {
    if (!quickjsModule) {
        const wasmModule = await getWasmModule();
        const variant = newVariant(RELEASE_SYNC, { wasmModule });
        quickjsModule = await newQuickJSWASMModuleFromVariant(variant);
    }
    return quickjsModule;
}

export function isScriptSupported() {
    return true;
}

const FORBIDDEN = [
    ['fetch(', '网络请求 fetch()'],
    ['WebSocket', '网络请求 WebSocket'],
    ['XMLHttpRequest', '网络请求 XMLHttpRequest'],
    ['EventSource', '网络请求 EventSource'],
    ['sendBeacon', '网络请求 sendBeacon'],
    ['require(', '模块加载 require()'],
    ['import(', '模块加载 import()'],
    ['process', '进程访问 process'],
    ['Buffer', '进程访问 Buffer'],
    ['Deno', '运行时访问 Deno'],
    ['child_process', '进程访问 child_process'],
    ['__dirname', '路径访问 __dirname'],
    ['__filename', '路径访问 __filename'],
    ['eval(', '代码执行 eval()'],
    ['new Function', '代码执行 new Function'],
    ['Function(', '代码执行 Function 构造'],
    ['setTimeout', '定时器 setTimeout'],
    ['setInterval', '定时器 setInterval'],
    ['queueMicrotask', '微任务调度 queueMicrotask'],
    ['globalThis', '全局对象 globalThis'],
    ['global.', '全局对象 global'],
    ['constructor', '原型链访问 constructor'],
    ['__proto__', '原型链访问 __proto__'],
    ['prototype', '原型链访问 prototype'],
    ['localStorage', '宿主存储 localStorage'],
    ['indexedDB', '宿主存储 indexedDB'],
    ['window.', '宿主对象 window'],
    ['self.', '宿主对象 self'],
    ['document.', '宿主 DOM document'],
];

export function auditScriptCode(code) {
    const src = String(code || '');
    const hits = [];
    for (const [token, why] of FORBIDDEN) {
        if (src.includes(token)) hits.push(why);
    }
    return hits;
}

function buildRegionMaps() {
    const regionMap = {};
    const flagMap = {};
    for (const r of REGIONS) {
        for (const kw of r.kw) {
            regionMap[kw] = r.code;
        }
        flagMap[r.code] = r.flag;
    }
    return { regionMap, flagMap };
}

export async function runScript(code, nodes, helpers = {}) {
    const src = String(code || '').trim();
    if (!src) {
        throw new Error('脚本为空：args.code 需要一段 (nodes, helpers) => nodes 的函数');
    }
    if (src.length > SCRIPT_MAX_CODE_LEN) {
        throw new Error(`脚本过长（超过 ${SCRIPT_MAX_CODE_LEN} 字符），请精简`);
    }
    const hits = auditScriptCode(src);
    if (hits.length) {
        throw new Error(`脚本包含被禁止的能力：${hits.join('、')}。请移除后重试。`);
    }

    const { regionMap, flagMap } = buildRegionMaps();
    const nodesJson = JSON.stringify(JSON.stringify(nodes));

    const wrapped = `
(function() {
    var regionMap = ${JSON.stringify(regionMap)};
    var flagMap = ${JSON.stringify(flagMap)};
    function regionOf(name) {
        for (var k in regionMap) { if (String(name).indexOf(k) >= 0) return regionMap[k]; }
        return '';
    }
    function flagOf(code) { return flagMap[code] || ''; }
    var h = {
        rename: function(node, name) { node.name = String(name || ''); return node; },
        regionOf: regionOf,
        flagOf: flagOf,
        log: function() {},
    };
    return (${src})(JSON.parse(${nodesJson}), h);
})()
`;

    const QuickJS = await getModule();
    let result;
    try {
        result = QuickJS.evalCode(wrapped, {
            shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + SCRIPT_TIMEOUT_MS),
        });
    } catch (e) {
        const msg = String(e?.message || e);
        if (/interrupted/i.test(msg)) {
            throw new Error(`脚本执行超时（超过 ${SCRIPT_TIMEOUT_MS / 1000} 秒）`);
        }
        throw new Error(`脚本执行出错：${msg.slice(0, 200)}`);
    }

    if (!Array.isArray(result)) {
        throw new Error('脚本返回值必须是节点数组（Array）');
    }

    const originalNames = new Map(nodes.map((n) => [n, n?.name]));
    for (const n of result) {
        if (!n || typeof n !== 'object') throw new Error('脚本返回了非法节点（非对象）');
        if (n.format && originalNames.get(n) !== n.name && (n.raw || n.obj)) {
            renameNode(n, n.name);
        }
    }
    return result;
}