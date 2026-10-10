
import { fail, ok, isPlainObject } from './util.js';
import { loadSnapshot } from './storage.js';
import { OPERATOR_TYPES, PROCESS_PRESETS } from './operators.js';
import { checkUrl, ssrfOptions } from './netguard.js';

const DEFAULT_TIMEOUT = 90000;

function aiConfig(settings, override = {}) {
    const ai = settings?.ai || {};
    return {
        baseUrl: String(override.baseUrl || ai.baseUrl || '').trim().replace(/\/+$/, ''),
        model: String(override.model || ai.model || '').trim(),
        apiKey: String(override.apiKey || ai.apiKey || '').trim(),
    };
}


async function checkAiOverride(env, body, effectiveBaseUrl) {
    const override = String(body?.baseUrl || '').trim();
    if (!override) return '';
    return await checkUrl(effectiveBaseUrl, ssrfOptions(env, { allowHttp: true, label: 'AI Base URL' }));
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
    
    const subList = Array.isArray(subs) ? subs : [];
    const colList = Array.isArray(collections) ? collections : [];
    const sampleList = Array.isArray(samples) ? samples : [];
    const totalCount = Number(total) || sampleList.length;

    
    
    
    
    const opDocs = OPERATOR_TYPES.map((o) => {
        const args = JSON.stringify(o.args);
        return [
            `- ${o.type}（${o.label}）：${o.desc}`,
            `  用法：${o.usage}`,
            `  默认 args: ${args}`,
        ].join('\n');
    }).join('\n');

    
    
    const taskHint =
        task === 'template'
            ? `
## 本次任务：编辑「自定义模板」
用户正在改的是一条**可复用的模板**（不绑定任何具体订阅）。
下面的节点样例借自站内某个订阅，**只作参考**：请写得通用一些，
不要写死只对那一份订阅成立的机场名 / 服务器名 / 编号。
`
            : '';

    
    
    
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
   - Region Pin：把指定地区**置顶/沉底**（regions 填地区码，position: top / bottom）。
     regions 可以填多个，**数组顺序就是组间先后** —— 「只调整某几个地区的先后、
     其他地区不动」用它最精准：regions:["DE","US"] 就是德国组整体排美国组前面，
     其余地区保持原有相对顺序（只是整体被推后/推前，先后不变）。
   - Keyword Sort：按**关键词**分组排序（keywords 按优先级填，名字包含该词即入组，
     unmatched: bottom / top 决定未命中的垫底还是置顶），组内保序、不改名。
     语义与 Region Pin 相同，只是分组依据是任意词而不是地区码；
     **按地区调序一律优先 Region Pin**（地区识别已内置，别舍近求远）。
   - Sort Operator：全表重排（by: name / type / server / region，sort: asc / desc）。
     只在用户确实想**整表**重新排队时用 —— 会打散现有顺序，
     用户说「只动一部分 / 其他保持原样」时不要选它。
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
- 德国排到美国前面，其他地区保持原顺序：
  [{"type":"Region Pin","args":{"regions":["DE","US"],"position":"top"}}]
  （regions 顺序即先后；想沉底就 position: "bottom"）
- 名字带「IEPL / IPLC / 专线」的排前面，其余垫底：
  [{"type":"Keyword Sort","args":{"keywords":["IEPL","IPLC","专线"],"unmatched":"bottom"}}]
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


const activeStreams = new Map();


export async function handleAiAbort(request) {
    let body = {};
    try {
        body = await request.json();
    } catch {
        
    }
    const id = String(body?.id || '');
    const stop = id ? activeStreams.get(id) : null;
    if (!stop) return ok({ aborted: false });
    activeStreams.delete(id);
    stop();
    return ok({ aborted: true });
}


export async function handleAiStream(request, env, ctx) {
    const snap = await loadSnapshot(env);
    const cfg = aiConfig(snap.settings);

    let body = {};
    try {
        body = await request.json();
    } catch {
        
    }

    
    
    
    
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
            
        }
    };
    try {
        request.signal?.addEventListener?.('abort', stopUpstream);
    } catch {
        
    }
    
    const streamId = String(body.id || '').trim() || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    activeStreams.set(streamId, stopUpstream);

    const stream = new ReadableStream({
        async start(controller) {
            const enc = new TextEncoder();
            
            
            const send = (obj) => {
                try {
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
                } catch {
                    
                }
            };
            
            const finish = () => {
                activeStreams.delete(streamId);
                try {
                    controller.close();
                } catch {
                    
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
                            
                        }
                    }
                }

                const proposal = extractProposal(acc);
                if (proposal) {
                    
                    
                    
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
            
        }
    }
    return null;
}


const CANONICAL_TYPES = new Map();
for (const o of OPERATOR_TYPES) {
    CANONICAL_TYPES.set(o.type.toLowerCase(), o.type);
    CANONICAL_TYPES.set(String(o.label || '').toLowerCase(), o.type);
}


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
        
        
        const opName = String(item.name ?? '').trim().slice(0, 40);
        if (opName) next.name = opName;
        chain.push(next);
    }
    return { chain, dropped };
}


export async function handleAiModels(request, env) {
    const snap = await loadSnapshot(env);
    let body = {};
    try {
        body = await request.json();
    } catch {
        
    }
    const cfg = aiConfig(snap.settings, body);
    if (!cfg.baseUrl) return fail('请先填写 AI Base URL', 400);
    
    
    const overrideBad = await checkAiOverride(env, body, cfg.baseUrl);
    if (overrideBad) return fail(overrideBad, 400);
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


export async function handleAiTest(request, env) {
    const snap = await loadSnapshot(env);
    let body = {};
    try {
        body = await request.json();
    } catch {
        
    }
    const cfg = aiConfig(snap.settings, body);
    
    
    if (!cfg.baseUrl) return fail('请先填写 AI Base URL', 400);
    if (!cfg.model) return fail('请先填写模型名（可点「拉取」从接口选）', 400);
    const overrideBad = await checkAiOverride(env, body, cfg.baseUrl);
    if (overrideBad) return fail(overrideBad, 400);
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


export function handleAiPresets() {
    return ok({ presets: PROCESS_PRESETS, types: OPERATOR_TYPES });
}
