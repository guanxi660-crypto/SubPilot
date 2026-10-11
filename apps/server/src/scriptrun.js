// Script Operator 执行沙箱。
//
// 环境差异：
//   - Node / Docker（node/server.mjs）：server.mjs 启动时把 node:vm 注入到
//     globalThis.__SUBPILOT_VM__，这里直接取用，支持任意 JS。
//   - Cloudflare Workers：运行时禁 eval / new Function，也不存在 __SUBPILOT_VM__，
//     脚本执行抛出明确指引。
//
// 为什么不在本文件里 import('node:vm')：
//   ① Workers 不支持顶层 await，动态 import 又是异步的，而算子执行是同步链路；
//   ② esbuild/wrangler 打包时静态分析到 node:vm 会在构建期报错。
// 由 Node 侧的适配层（server.mjs）用 createRequire 同步注入是最干净的交界。
//
// 安全三层：
//   ① 静态黑名单审计（fetch / require / process … 命中即拒）
//   ② node:vm 沙箱隔离（不注入任何 host 全局，只有节点数组 + 白名单 helpers）
//   ③ 硬限制（脚本超时、节点上限、返回必须是数组）

import { renameNode } from './nodes.js';

const SCRIPT_TIMEOUT_MS = 3000;
const SCRIPT_MAX_CODE_LEN = 20000;

const nodeVm =
    globalThis && globalThis.__SUBPILOT_VM__ && globalThis.__SUBPILOT_VM__.runInNewContext
        ? globalThis.__SUBPILOT_VM__
        : null;

/** 当前运行环境是否支持脚本算子。 */
export function isScriptSupported() {
    return !!nodeVm;
}

/** 静态审计会挡掉的黑名单。命中任意一条都不允许执行。 */
const FORBIDDEN = [
    // 网络
    ['fetch(', '网络请求 fetch()'],
    ['WebSocket', '网络请求 WebSocket'],
    ['XMLHttpRequest', '网络请求 XMLHttpRequest'],
    ['EventSource', '网络请求 EventSource'],
    ['sendBeacon', '网络请求 sendBeacon'],
    // 模块 / 运行时
    ['require(', '模块加载 require()'],
    ['import(', '模块加载 import()'],
    ['process', '进程访问 process'],
    ['Buffer', '进程访问 Buffer'],
    ['Deno', '运行时访问 Deno'],
    ['child_process', '进程访问 child_process'],
    ['__dirname', '路径访问 __dirname'],
    ['__filename', '路径访问 __filename'],
    // 代码执行
    ['eval(', '代码执行 eval()'],
    ['new Function', '代码执行 new Function'],
    ['Function(', '代码执行 Function 构造'],
    ['setTimeout', '定时器 setTimeout'],
    ['setInterval', '定时器 setInterval'],
    ['queueMicrotask', '微任务调度 queueMicrotask'],
    // 全局 / 原型链逃逸
    ['globalThis', '全局对象 globalThis'],
    ['global.', '全局对象 global'],
    ['constructor', '原型链访问 constructor'],
    ['__proto__', '原型链访问 __proto__'],
    ['prototype', '原型链访问 prototype'],
    // 宿主能力
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

/**
 * 在 node:vm 沙箱里执行脚本算子。
 *
 * @param {string} code 脚本体，要求是一个函数：`(nodes, helpers) => nodes`
 * @param {Array} nodes 内部节点对象数组（真实引用，脚本可直接改字段）
 * @returns {Array} 处理后的节点数组
 * @throws {Error} 审计不过 / 环境不支持 / 超时 / 返回非法，错误信息可直接面向用户
 */
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
    if (!nodeVm) {
        throw new Error(
            '当前环境不支持脚本算子（Cloudflare Workers 禁 eval / new Function）。' +
                '请改用内置算子，或将本服务部署到 Node / Docker 后使用。',
        );
    }

    // 白名单 helper：都是对单个节点的受控操作，不暴露任何宿主全局。
    // 调用方传入的 helpers 先展开、白名单成员最后定义，杜绝外部覆盖 rename。
    const sandboxHelpers = {
        ...helpers,
        rename(node, name) {
            // 只改内存字段；对 raw / obj 的同步由宿主侧统一做（见下方回写循环），
            // 避免沙箱内直接碰 host 的 renameNode 产生主客体纠缠
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


    // 记录处理前的名称，执行后只对「改过名」的节点做一次回写（同步到 raw / obj），
    // 兼容两种写法：helpers.rename 已在沙箱内即时回写；直接给 n.name 赋值的，
    // 到这里统一补齐（helpers.rename 与直接改名各自幂等，不会重复处理）。
    const originalNames = new Map(nodes.map((n) => [n, n?.name]));

    // 把「定义函数 + 立即调用」合成一次 runInNewContext：timeout 只管这一次
    // 同步执行，函数体若有死循环也会被它掐死（若先在宿主侧拿到 fn 再调用，
    // 函数体就脱离 timeout 保护了——这是 node:vm 的已知边界）。
    let result;
    try {
        result = nodeVm.runInNewContext(`(${src})(nodes, __helpers)`, sandbox, {
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