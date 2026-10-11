// Script Operator 执行沙箱（Node 专用）。
//
// dev 分支只跑 Node / Docker，直接 import node:vm，不再需要 globalThis hack。
// main 分支后续剥离为 Worker-only 时，Worker 不支持 eval / new Function，
// 脚本算子自然不可用——届时由 api.js 的 scriptSupported 字段告知前端。
//
// 安全三层：
//   ① 静态黑名单审计（fetch / require / process … 命中即拒）
//   ② node:vm 沙箱隔离（不注入任何 host 全局，只有节点数组 + 白名单 helpers）
//   ③ 硬限制（脚本超时、节点上限、返回必须是数组）

import vm from 'node:vm';
import { renameNode } from './nodes.js';

const SCRIPT_TIMEOUT_MS = 3000;
const SCRIPT_MAX_CODE_LEN = 20000;

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

export function runScript(code, nodes, helpers = {}) {
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

    const sandboxHelpers = {
        ...helpers,
        rename(node, name) {
            node.name = String(name ?? '');
            return node;
        },
        regionOf: helpers.regionOf,
        flagOf: helpers.flagOf,
        log: helpers.log,
    };

    const sandbox = {
        nodes,
        __helpers: sandboxHelpers,
        Math,
        Date,
        JSON,
        RegExp,
        Map,
        Set,
        Promise,
        Number,
        String,
        Boolean,
        Array,
        Object,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        console: {
            log: sandboxHelpers.log,
            warn: sandboxHelpers.log,
            error: sandboxHelpers.log,
            info: sandboxHelpers.log,
        },
    };

    const originalNames = new Map(nodes.map((n) => [n, n?.name]));

    let result;
    try {
        result = vm.runInNewContext(`(${src})(nodes, __helpers)`, sandbox, {
            timeout: SCRIPT_TIMEOUT_MS,
            filename: 'script-operator.js',
        });
    } catch (e) {
        const msg = String(e?.message || e);
        if (/timed\s*out|timeout/i.test(msg)) {
            throw new Error(`脚本执行超时（超过 ${SCRIPT_TIMEOUT_MS / 1000} 秒）`);
        }
        throw new Error(`脚本执行出错：${msg.slice(0, 200)}`);
    }
    if (!Array.isArray(result)) {
        throw new Error('脚本返回值必须是节点数组（Array）');
    }
    for (const n of result) {
        if (!n || typeof n !== 'object') throw new Error('脚本返回了非法节点（非对象）');
        if (n.format && originalNames.get(n) !== n.name && (n.raw || n.obj)) {
            renameNode(n, n.name);
        }
    }
    return result;
}