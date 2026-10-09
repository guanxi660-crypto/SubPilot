// AI 助手：OpenAI 兼容接口的 SSE 流式代理。
//
// 为什么必须走服务端代理而不是浏览器直连：
//   · API Key 存在服务端 KV，不下发到浏览器（浏览器里能看到的东西就等于公开）
//   · 多数 OpenAI 兼容服务不给浏览器发 CORS 头，直连必然失败
//
// 助手的职责边界（写进系统提示词，也写进前端说明）：
//   它能产出**算子链 JSON 提案**，不能执行任意代码、不能测速、不能访问本地文件。
//   这些边界是运行时事实，不是产品取舍 —— 说清楚比让模型瞎猜好。

import { fail, ok, isPlainObject } from './util.js';
import { loadSnapshot } from './storage.js';
import { OPERATOR_TYPES, PROCESS_PRESETS } from './operators.js';

const DEFAULT_TIMEOUT = 90000;

function aiConfig(settings, override = {}) {
    const ai = settings?.ai || {};
    return {
        baseUrl: String(override.baseUrl || ai.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(override.model || ai.model || '').trim(),
        apiKey: String(override.apiKey || ai.apiKey || '').trim(),
    };
}

export function buildSystemPrompt({
    subs,
    collections,
    samples,
    total,
    task,
    currentProcess,
    currentTarget,
}) {
    // 参数一律归一：调用方漏传某项时不该整个请求 500，退化成「站内没有数据」就好。
    const subList = Array.isArray(subs) ? subs : [];
    const colList = Array.isArray(collections) ? collections : [];
    const sampleList = Array.isArray(samples) ? samples : [];
    const totalCount = Number(total) || sampleList.length;

    // opDocs 带上 usage 全文 —— 那是每个算子的参数级文档（默认值、填法、坑位）。
    // 早先只投喂 desc + 默认 args，AI 对参数的了解不够细，遇到过「明明有算子
    // 却说做不到」的情况。参考 vaeann/sub-store-scripts 的做法：脚本头部的
    // 参数文档写到多细，投喂给 AI 的就该有多细。
    const opDocs = OPERATOR_TYPES.map((o) => {
        const args = JSON.stringify(o.args);
        return [
            `- ${o.type}（${o.label}）：${o.desc}`,
            `  用法：${o.usage}`,
            `  默认 args: ${args}`,
        ].join('\n');
    }).join('\n');

    // 模板 vs 具体订阅：两者的"好答案"不一样。模板要通用、能反复套用；
    // 针对某个订阅则应当贴着它真实的节点名来写。说清楚比让模型自己猜好。
    const taskHint =
        task === 'template'
            ? `
## 本次任务：编辑「自定义模板」
用户正在改的是一条**可复用的模板**（不绑定任何具体订阅）。
下面的节点样例借自站内某个订阅，**只作参考**：请写得通用一些，
不要写死只对那一份订阅成立的机场名 / 服务器名 / 编号。
`
            : '';

    // 当前算子链：没有它，助手只能从对话历史里猜用户已经改到哪一步 ——
    // 「再帮我加一条」「把刚才的排序去掉」这类增量请求全都答不准，
    // 用户的感觉就是「AI 笨」。把草稿链原样投喂，增量修改才成立。
    const chain = Array.isArray(currentProcess) ? currentProcess : [];
    const target = String(currentTarget || '').trim();
    const chainSection = `
## 当前算子链（正在编辑：${target || '未指定来源'}）
下面是用户编辑器里的**草稿链**，按数组顺序依次执行：
${chain.length ? `\`\`\`json\n${JSON.stringify(chain, null, 2)}\n\`\`\`` : '（空 —— 还没有任何算子）'}

用户说「再加一条 / 去掉某条 / 改一下 / 把刚才那个排序去掉」时，请在这条链的基础上做**增量修改**，
输出**修改后的完整链**（不是只输出新增的那一条）。链为空时才从零开始写。
`;

    return `你是 SubPilot 的订阅整理助手。SubPilot 把订阅转换委托给 SubConverter-Extended，你负责的是**节点级整理**：筛选、排序、重命名。

## 你可以做的事
用一份 JSON 算子链（数组）描述对节点的操作。可用算子：
${opDocs}
${taskHint}${chainSection}
## 执行顺序
算子链是**有序**的：数组第 1 个先执行，它的输出作为第 2 个的输入，依次往下。
顺序会改变结果 —— 例如「先按地区排序、再把 SG 置顶」与「先置顶、再按地区排序」
结果完全不同（后者会把置顶覆盖掉）。写链时请按你期望的最终效果排好顺序。

## 技能：按「要改变什么」挑工具
每个算子能改变的范围不同，挑最贴合意图的那个即可。没有完全贴切的算子时，
**自由组合也算数**（包括用改名技巧实现排序），只要在说明里讲清楚会动什么、让用户心里有数：

1. **改顺序**（节点都在、名字不动）
   - Sort Operator：全表重排（by: name / type / server / region，sort: asc / desc）
   - Region Pin：把指定地区**置顶/沉底**（regions 填地区码，position: top / bottom），
     组内和其余节点都保持原顺序 —— 想「某地区排最前」它最省事
2. **改名字**（节点都在、顺序不动）
   - Regex Rename（成对「模式, 替换」，支持 $1）、Regex Delete（只删片段）、
     Name Prefix / Name Suffix（统一前后缀）、Flag Operator（加/去国旗）、
     Handle Duplicate(action: "rename")（重名加序号）
3. **改存在**（增删节点）：Regex Filter / Region Filter / Type Filter / Useless Filter /
   Limit Operator、Handle Duplicate(action: "delete")
4. **改节点字段**（仅 Clash 形态）：Quick Settings（udp / tfo / skip-cert-verify）

地区识别是内置的：中文名、国旗 emoji、两字母码都认得。排序、置顶、地区筛选
都可以直接用 Region Filter / Region Pin 的 regions 参数，不用自己写正则猜地区。

## 常见任务 → JSON 写法对照（直接照这个风格写）
- 新加坡置顶（不改名）：[{"type":"Region Pin","args":{"regions":["SG"],"position":"top"}}]
- SG 置顶且其余按地区排（先排后钉，顺序不能反）——
  [{"type":"Sort Operator","args":{"sort":"asc","by":"region"}},
   {"type":"Region Pin","args":{"regions":["SG"],"position":"top"}}]
- 港台日新美按地区排 + 国旗：
  [{"type":"Region Filter","args":{"regions":["HK","TW","JP","SG","US"],"mode":"keep"}},
   {"type":"Sort Operator","args":{"sort":"asc","by":"region"}},
   {"type":"Flag Operator","args":{"mode":"add"}}]
- 删假节点：[{"type":"Useless Filter","args":{}},
  {"type":"Regex Filter","args":{"regex":["(?i)剩余|流量|官网|到期"],"mode":"exclude"}}]
- 去掉「机场名 | 」前缀：[{"type":"Regex Rename","args":{"regex":["^[^|｜]*[|｜]\\\\s*",""]}}]
- 重名加序号：[{"type":"Handle Duplicate","args":{"action":"rename"}}]

## 输出格式（严格遵守）
先用中文简短说明你打算做什么（2-4 句，不要长篇大论），然后给出一个 \`\`\`json 代码块，内容是算子链数组。整体长这样：
\`\`\`json
[
  { "type": "Useless Filter", "args": {} },
  { "type": "Region Pin", "args": { "regions": ["SG"], "position": "top" } },
  { "type": "Sort Operator", "args": { "sort": "asc", "by": "region" } }
]
\`\`\`
如果用户只是提问、不需要改动算子链，就不要输出 json 代码块。

## 你不知道的事（不要编造）
- 节点延迟、可用性、带宽：你拿不到任何测速数据。禁止推荐或编写测速脚本。
- 你不能运行任意 JavaScript（运行时不支持 eval），没有 "Script Operator" 这种算子。
- 你看不到完整的节点列表，只有下面这些样例。

## 当前站内数据
订阅（${subList.length} 个）：${subList.map((s) => s.name).join('、') || '（无）'}
组合（${colList.length} 个）：${colList.map((c) => c.name).join('、') || '（无）'}

节点样例（共 ${totalCount} 个，仅列出前 ${sampleList.length} 个 —— 其余你看不到，
不要假装知道完整列表，也不要凭数量推断内容）：
${sampleList.map((s) => `${s.name} (${s.type} ${s.server}:${s.port})`).join('\n') || '（无）'}

## 风格
中文，直接给结论。不要客套话，不要"好问题"。`;
}

/**
 * 活跃流注册表：streamId → 掐上游的回调。
 *
 * 为什么除了 request.signal / stream.cancel 还要这条显式通道：
 *   · 线上两者都会在客户端断开时触发，但它们依赖 runtime 的断连语义；
 *   · `wrangler dev` 的本地代理**不会**把客户端断连传进 isolate
 *     （实测 cancel() 与 request.signal 都不触发），本地根本验不了「停止」是否
 *     真的省下了 token；
 *   · 不同 runtime / 反代对断连的处理也不一致。
 * 所以客户端点「停止」时，除了断开 SSE，还会带 streamId 打一次 /ai/assistant/abort，
 * 由服务端主动掐掉上游。多一条通道，行为就不依赖 runtime 的脾气。
 */
const activeStreams = new Map();

/** POST /ai/assistant/abort —— body: { id } 显式中止某条流的上游请求 */
export async function handleAiAbort(request) {
    let body = {};
    try {
        body = await request.json();
    } catch {
        /* 空 body 按未命中处理 */
    }
    const id = String(body?.id || '');
    const stop = id ? activeStreams.get(id) : null;
    if (!stop) return ok({ aborted: false });
    activeStreams.delete(id);
    stop();
    return ok({ aborted: true });
}

/**
 * POST /ai/assistant/stream
 * body: { messages:[{role,content}], samples?:[], total?:n, task?:'template'|'source',
 *         process?:[] 当前草稿算子链, target?:'来源显示名', id?:'客户端生成的中止标识' }
 * 返回 SSE：event 由 data 里的 type 字段区分 —— meta / delta / proposal / error / done
 * 客户端断开连接、或调用 /ai/assistant/abort 都会把上游模型请求一起 abort。
 */
export async function handleAiStream(request, env, ctx) {
    const snap = await loadSnapshot(env);
    const cfg = aiConfig(snap.settings);

    let body = {};
    try {
        body = await request.json();
    } catch {
        /* 空 body 走默认 */
    }

    // 上游请求的中止开关。客户端点「停止」或直接关页面时，要把上游一起掐掉，
    // 否则模型还在后台继续吐 token（白花钱），只是没人看得到。
    // 四条中止路径：request.signal（浏览器断开）、stream.cancel（流被取消）、
    // 超时定时器、以及客户端显式打 /ai/assistant/abort（见 activeStreams 注释）。
    const upstream = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        upstream.abort();
    }, DEFAULT_TIMEOUT);
    const stopUpstream = () => {
        clearTimeout(timer);
        try {
            upstream.abort();
        } catch {
            /* 已中止 */
        }
    };
    try {
        request.signal?.addEventListener?.('abort', stopUpstream);
    } catch {
        /* 某些 runtime 的 signal 不支持 */
    }
    // 客户端可自带 id（便于它在断开前就知道用哪个 id 去 abort）；没带就服务端发一个。
    const streamId = String(body.id || '').trim() || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    activeStreams.set(streamId, stopUpstream);

    const stream = new ReadableStream({
        async start(controller) {
            const enc = new TextEncoder();
            // 客户端断开后再 enqueue 会抛 TypeError，这里一律吞掉 ——
            // 否则一个正常的「用户点了停止」会变成 500 日志。
            const send = (obj) => {
                try {
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
                } catch {
                    /* 客户端已断开 */
                }
            };
            // 先把 id 告诉客户端：它拿这个 id 去 /ai/assistant/abort 显式中止
            const finish = () => {
                activeStreams.delete(streamId);
                try {
                    controller.close();
                } catch {
                    /* 已关闭 */
                }
            };
            send({ type: 'meta', id: streamId });

            if (!cfg.baseUrl) {
                send({
                    type: 'error',
                    message: '还没有配置 AI 接口。请到「设置 → AI 助手」填写 Base URL、模型名和 API Key。',
                });
                send({ type: 'done' });
                finish();
                return;
            }

            const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
            const system = buildSystemPrompt({
                subs: snap.subs,
                collections: snap.collections,
                samples: Array.isArray(body.samples) ? body.samples.slice(0, 60) : [],
                total: Number(body.total) || 0,
                task: body.task === 'template' ? 'template' : 'source',
                currentProcess: Array.isArray(body.process) ? body.process : [],
                currentTarget: String(body.target || ''),
            });

            const payload = {
                model: cfg.model,
                stream: true,
                temperature: 0.3,
                messages: [
                    { role: 'system', content: system },
                    ...messages
                        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
                        .map((m) => ({ role: m.role, content: String(m.content || '') })),
                ],
            };

            let acc = '';
            try {
                const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${cfg.apiKey}`,
                    },
                    body: JSON.stringify(payload),
                    signal: upstream.signal,
                });

                if (!res.ok) {
                    const t = await res.text().catch(() => '');
                    send({
                        type: 'error',
                        message: `AI 接口返回 HTTP ${res.status}：${String(t).slice(0, 300)}`,
                    });
                    send({ type: 'done' });
                    finish();
                    return;
                }

                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    for (const line of lines) {
                        const t = line.trim();
                        if (!t.startsWith('data:')) continue;
                        const data = t.slice(5).trim();
                        if (!data || data === '[DONE]') continue;
                        try {
                            const j = JSON.parse(data);
                            const delta = j.choices?.[0]?.delta?.content;
                            if (delta) {
                                acc += delta;
                                send({ type: 'delta', delta });
                            }
                        } catch {
                            /* 心跳 / 非 JSON 行忽略 */
                        }
                    }
                }

                const proposal = extractProposal(acc);
                if (proposal) {
                    // 校验一遍再下发：模型偶尔会编出「Script Operator」这种不存在的算子，
                    // 或者把 type 写成中文 label。这里做一次归一 + 过滤，
                    // 落不到链上的直接剔掉并告知用户，别让无效算子混进草稿。
                    const { chain, dropped } = validateProposal(proposal);
                    if (chain.length) {
                        send({ type: 'proposal', process: chain, dropped });
                    } else {
                        send({
                            type: 'error',
                            message: `助手给出的算子本站都不支持（${dropped.join('、') || '无法解析'}），这次提案已丢弃，换个说法再试。`,
                        });
                    }
                }
                send({ type: 'done' });
            } catch (e) {
                if (e.name === 'AbortError') {
                    // 用户点「停止」时客户端已断开，这里通常什么都不用发；
                    // 只有超时才需要一句可读的提示。
                    if (timedOut) {
                        send({
                            type: 'error',
                            message: `AI 请求超时（${Math.round(DEFAULT_TIMEOUT / 1000)}s 无响应）。可换个更快的模型，或把问题拆小一点再问。`,
                        });
                    }
                } else {
                    send({ type: 'error', message: `AI 调用失败：${e.message || String(e)}` });
                }
                send({ type: 'done' });
            } finally {
                clearTimeout(timer);
                finish();
            }
        },
        // 客户端断开 SSE（点停止 / 关页面 / 切路由）时 runtime 会调到这里 ——
        // 这是把「停止」传导到上游模型请求最可靠的一处。
        cancel() {
            stopUpstream();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream;charset=UTF-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

function withTimeout(ms) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
}

/**
 * 从回复里抠出算子链提案。
 * 取**最后一个** json 代码块 —— 模型常常先给个示例再给正式结果，
 * 取第一个会把示例当成提案。
 */
export function extractProposal(text) {
    const blocks = [...String(text || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (let i = blocks.length - 1; i >= 0; i--) {
        const raw = blocks[i][1].trim();
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every((x) => isPlainObject(x) && x.type)) {
                return parsed;
            }
        } catch {
            /* 试下一个 */
        }
    }
    return null;
}

// 算子名归一表：模型有时会写中文 label（「区域置顶」）、大小写不一致（"region pin"），
// 或者干脆编一个不存在的算子。这里统一收口，只放行真正能执行的。
const CANONICAL_TYPES = new Map();
for (const o of OPERATOR_TYPES) {
    CANONICAL_TYPES.set(o.type.toLowerCase(), o.type);
    CANONICAL_TYPES.set(String(o.label || '').toLowerCase(), o.type);
}

/**
 * 校验并归一 AI 给出的算子链。
 * 返回 { chain, dropped }：chain 是清洗后可直接执行的链，dropped 是被剔除的原始 type。
 * 保留 args 原样 —— 参数合法性由算子自身的执行期校验负责，这里不越权。
 */
export function validateProposal(input) {
    const chain = [];
    const dropped = [];
    for (const item of Array.isArray(input) ? input : []) {
        if (!isPlainObject(item)) {
            dropped.push(String(item).slice(0, 40));
            continue;
        }
        const raw = String(item.type || '').trim();
        const canonical = CANONICAL_TYPES.get(raw.toLowerCase());
        if (!canonical) {
            dropped.push(raw || '(缺 type)');
            continue;
        }
        const next = { type: canonical, args: isPlainObject(item.args) ? item.args : {} };
        // 自定义显示名跟着一起过 —— 否则让 AI 改一下模板，用户起的名字就没了。
        // 它不是执行参数，SCE 按 type 查处理函数，多这一个键会被忽略。
        const opName = String(item.name ?? '').trim().slice(0, 40);
        if (opName) next.name = opName;
        chain.push(next);
    }
    return { chain, dropped };
}

/** POST /ai/models —— 列出可用模型（可以用未保存的草稿配置探测） */
export async function handleAiModels(request, env) {
    const snap = await loadSnapshot(env);
    let body = {};
    try {
        body = await request.json();
    } catch {
        /* ignore */
    }
    const cfg = aiConfig(snap.settings, body);
    if (!cfg.baseUrl) return fail('请先填写 AI Base URL', 400);
    try {
        const res = await fetch(`${cfg.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
            signal: withTimeout(15000),
        });
        if (!res.ok) return fail(`上游返回 HTTP ${res.status}`, 502);
        const j = await res.json();
        const list = Array.isArray(j.data) ? j.data.map((m) => m.id).filter(Boolean) : [];
        return ok(list);
    } catch (e) {
        return fail(`获取模型列表失败：${e.message || e}`, 502);
    }
}

/** POST /ai/settings/test —— 发一个最小请求探活 */
export async function handleAiTest(request, env) {
    const snap = await loadSnapshot(env);
    let body = {};
    try {
        body = await request.json();
    } catch {
        /* ignore */
    }
    const cfg = aiConfig(snap.settings, body);
    // 两项缺啥报啥 —— 早先合并成一句「请先填写 Base URL 与模型名」，
    // 用户明明填了 Base URL 也被点名，误以为没填上。
    if (!cfg.baseUrl) return fail('请先填写 AI Base URL', 400);
    if (!cfg.model) return fail('请先填写模型名（可点「拉取」从接口选）', 400);
    const started = Date.now();
    try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 5,
            }),
            signal: withTimeout(20000),
        });
        const t = await res.text().catch(() => '');
        if (!res.ok) return fail(`探活失败 HTTP ${res.status}：${String(t).slice(0, 200)}`, 502);
        return ok({ ok: true, ms: Date.now() - started });
    } catch (e) {
        return fail(`探活失败：${e.message || e}`, 502);
    }
}

/** GET /ai/presets —— 算子模板（前端「一键套用」用） */
export function handleAiPresets() {
    return ok({ presets: PROCESS_PRESETS, types: OPERATOR_TYPES });
}
