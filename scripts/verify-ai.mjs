// AI 助手链路验证：单元（提案校验 / 提示词拼装）+ 端到端（SSE 透传 / 中止传播）。
//
// 为什么要在本机起一个假的上游模型服务：
//   · 真实模型调用又慢又随机，测不出「系统提示词里到底有没有当前算子链」
//   · 「客户端点停止 → 上游请求被 abort」这条只能靠服务端观测，必须有可控上游
// 假上游按最后一条 user 消息里的暗号切模式：__HANG__ 挂着不回、__BADOP__ 回一份
// 带编造算子的提案，其余回普通流。
//
// 依赖本地 dev 服务（8795）。跑完会把 AI 配置清空（与 verify.mjs 收尾一致）。

import http from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'http://127.0.0.1:8795';
const TOKEN = 'dev-local-token';
const UPSTREAM_PORT = 8797;

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
    ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假上游 ----------
const state = { payloads: [], hangAborted: 0, hangCompleted: 0 };

const mock = http.createServer((req, res) => {
    if (req.url === '/__state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
        let payload = {};
        try {
            payload = JSON.parse(raw);
        } catch {
            /* 非 JSON 就当成空 */
        }
        state.payloads.push(payload);
        const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
        const last = String(msgs[msgs.length - 1]?.content || '');

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

        if (last.includes('__HANG__')) {
            // 挂住不回：模拟「模型还在慢慢吐」。客户端一断，这里应该看到 close。
            let finished = false;
            res.on('close', () => {
                if (!finished) state.hangAborted++;
            });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '先想一下…' } }] })}\n\n`);
            return;
        }

        let text;
        if (last.includes('__BADOP__')) {
            text = '我打算先清掉无效节点，再把新加坡置顶。\n```json\n[{"type":"Useless Filter","args":{}},{"type":"Script Operator","args":{}},{"type":"地区置顶","args":{"regions":["SG"],"position":"top"}}]\n```\n';
        } else if (last.includes('__ALLOPS__')) {
            text = '好的。\n```json\n[{"type":"Magic Operator","args":{}},{"type":"Script Operator","args":{}}]\n```\n';
        } else {
            text = '好的，收到，我这就帮你整理节点。';
        }

        for (const piece of text.match(/[\s\S]{1,6}/g) || []) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    });
});

await new Promise((r) => mock.listen(UPSTREAM_PORT, '127.0.0.1', r));

// ---------- 单元：validateProposal / extractProposal / buildSystemPrompt ----------
const ai = await import(pathToFileURL(resolve(process.cwd(), 'apps/server/src/ai.js')).href);

{
    const { chain, dropped } = ai.validateProposal([
        { type: 'Useless Filter', args: {} },
        { type: 'Script Operator', args: {} },
        { type: '地区置顶', args: { regions: ['SG'], position: 'top' } },
        { type: 'region pin', args: {} },
        42,
        { args: {} },
    ]);
    check('校验：合法算子保留', chain.length === 3 && chain[0].type === 'Useless Filter');
    check(
        '校验：中文 label 归一成规范 type',
        chain.some((x) => x.type === 'Region Pin' && x.args?.regions?.[0] === 'SG'),
        JSON.stringify(chain[2]),
    );
    check('校验：大小写不一致也能归一', chain.filter((x) => x.type === 'Region Pin').length === 2);
    check(
        '校验：编造的算子被剔掉并记入 dropped',
        dropped.includes('Script Operator') && dropped.includes('42') && dropped.includes('(缺 type)'),
        dropped.join('、'),
    );
    const noArgs = ai.validateProposal([{ type: 'Useless Filter' }]);
    check('校验：缺 args 补成空对象', noArgs.chain[0]?.args && Object.keys(noArgs.chain[0].args).length === 0);
    check('校验：非数组输入返回空链', ai.validateProposal('nope').chain.length === 0);
}

{
    // 模型常常先给示例再给正式结果 —— 必须取最后一个代码块
    const text = '示例：\n```json\n[{"type":"Limit Operator","args":{"limit":1}}]\n```\n正式：\n```json\n[{"type":"Sort Operator","args":{"by":"region"}}]\n```';
    const p = ai.extractProposal(text);
    check('提取：取最后一个 json 代码块', p?.length === 1 && p[0].type === 'Sort Operator', JSON.stringify(p));
    check('提取：没有代码块时返回 null', ai.extractProposal('就是聊聊天') === null);
}

{
    const sys = ai.buildSystemPrompt({
        subs: [{ name: 'a' }],
        collections: [],
        samples: [{ name: '香港 01', type: 'ss', server: 'h.k', port: 443 }],
        total: 100,
        task: 'source',
        currentProcess: [{ type: 'Useless Filter', args: {} }],
        currentTarget: '演示机场 A',
    });
    check('提示词：带上当前草稿算子链', sys.includes('Useless Filter') && sys.includes('当前算子链'));
    check('提示词：标出正在编辑的来源名', sys.includes('演示机场 A'));
    check('提示词：讲清算子链是有序的', sys.includes('执行顺序'));
    check('提示词：如实说明只看到样例而非全量', sys.includes('仅列出前 1 个'));
    check('提示词：空链时有兜底文案', ai.buildSystemPrompt({ samples: [], total: 0, currentProcess: [] }).includes('还没有任何算子'));
}

// ---------- 端到端 ----------
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function setAi(patch) {
    const r = await fetch(`${BASE}/api/settings`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ai: patch }),
    });
    return r.json();
}

async function readSse(res, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const events = [];
    let buf = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop() || '';
            for (const part of parts) {
                const line = part.split('\n').find((l) => l.startsWith('data:'));
                if (!line) continue;
                let evt;
                try {
                    evt = JSON.parse(line.slice(5).trim());
                } catch {
                    continue;
                }
                events.push(evt);
                onEvent?.(evt);
            }
        }
    } catch (e) {
        if (e.name !== 'AbortError') throw e;
    }
    return events;
}

const stream = (body, signal) =>
    fetch(`${BASE}/ai/assistant/stream`, { method: 'POST', headers: auth, body: JSON.stringify(body), signal });

await setAi({ baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`, model: 'mock-model', apiKey: 'sk-mock' });

// 1) 正常流：delta 透传 + done 收尾
{
    const res = await stream({
        messages: [{ role: 'user', content: '你好' }],
        samples: [],
        total: 0,
        process: [{ type: 'Useless Filter', args: {} }],
        target: '演示机场 A',
    });
    const events = await readSse(res);
    check('端到端：HTTP 200', res.status === 200, String(res.status));
    check(
        '端到端：SSE 头正确',
        String(res.headers.get('content-type')).includes('text/event-stream'),
        String(res.headers.get('content-type')),
    );
    check('端到端：首个事件是 meta（带 streamId）', events[0]?.type === 'meta' && !!events[0]?.id, JSON.stringify(events[0]));
    const deltas = events.filter((e) => e.type === 'delta');
    check('端到端：delta 逐块透传', deltas.length >= 2, `${deltas.length} 块`);
    check('端到端：正文拼起来正确', deltas.map((d) => d.delta).join('') === '好的，收到，我这就帮你整理节点。');
    check('端到端：最后发 done', events.at(-1)?.type === 'done');

    // 上游到底收到了什么 —— 提示词里必须有前端传来的草稿链和目标名
    const sys = String(state.payloads.at(-1)?.messages?.[0]?.content || '');
    check('端到端：草稿链进了系统提示词', sys.includes('Useless Filter'));
    check('端到端：目标来源名进了系统提示词', sys.includes('演示机场 A'));
    check('端到端：stream=true 且带上模型名', state.payloads.at(-1)?.stream === true && state.payloads.at(-1)?.model === 'mock-model');
}

// 2) 带编造算子的提案：合法部分下发，编造的剔掉并上报
{
    const res = await stream({ messages: [{ role: 'user', content: '__BADOP__ 清理一下' }] });
    const events = await readSse(res);
    const proposal = events.find((e) => e.type === 'proposal');
    check('端到端：下发 proposal 事件', !!proposal, JSON.stringify(proposal)?.slice(0, 120));
    check(
        '端到端：提案只留能执行的算子',
        proposal?.process?.length === 2 && proposal.process.every((x) => ['Useless Filter', 'Region Pin'].includes(x.type)),
        JSON.stringify(proposal?.process),
    );
    check(
        '端到端：编造算子通过 dropped 如实上报',
        proposal?.dropped?.includes('Script Operator'),
        JSON.stringify(proposal?.dropped),
    );
    check('端到端：中文 label 已归一成 type', proposal?.process?.[1]?.type === 'Region Pin');
}

// 3) 提案里的算子全都不认识：不落库，回一条可读的 error
{
    const res = await stream({ messages: [{ role: 'user', content: '__ALLOPS__ 帮我改' }] });
    const events = await readSse(res);
    check('端到端：全是编造算子时不下发 proposal', !events.some((e) => e.type === 'proposal'));
    const err = events.find((e) => e.type === 'error');
    check(
        '端到端：如实告知哪些算子不支持',
        !!err && err.message.includes('Magic Operator') && err.message.includes('Script Operator'),
        String(err?.message),
    );
    check('端到端：仍然以 done 收尾', events.at(-1)?.type === 'done');
}

// 4) 中止：客户端带 streamId 打 /ai/assistant/abort → 上游请求被掐断
//
// 为什么不靠「断开 SSE」来测：`wrangler dev` 的本地代理不把客户端断连传进 isolate
// （实测 stream.cancel 与 request.signal 都不触发），只有线上才认。所以
// /ai/assistant/abort 这条显式通道既是线上双保险，也是本地唯一能验证的路径。
{
    const before = (await (await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__state`)).json()).hangAborted;
    const sid = 'verify-abort-1';
    const ctrl = new AbortController();
    const res = await stream({ messages: [{ role: 'user', content: '__HANG__ 慢慢来' }], id: sid }, ctrl.signal);
    let sawMeta = false;
    const done = readSse(res, (e) => {
        if (e.type === 'meta') sawMeta = true;
    });
    // 等上游真的把第一块吐出来，确保请求已经打到假上游了
    for (let i = 0; i < 40 && !sawMeta; i++) await sleep(50);
    await sleep(300);

    const ab = await (await fetch(`${BASE}/ai/assistant/abort`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ id: sid }),
    })).json();
    check('中止：服务端确认命中该流', ab?.data?.aborted === true, JSON.stringify(ab));

    await sleep(1000);
    const after = (await (await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/__state`)).json()).hangAborted;
    check('中止：上游连接被掐断（token 不再白烧）', after > before, `${before} → ${after}`);

    ctrl.abort();
    await done.catch(() => {});

    const miss = await (await fetch(`${BASE}/ai/assistant/abort`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ id: 'not-a-real-id' }),
    })).json();
    check('中止：未知 id 不报错，只回 aborted=false', miss?.data?.aborted === false, JSON.stringify(miss));
}

// 5) 未配置 AI 接口时的兜底提示
{
    await setAi({ baseUrl: '' });
    const res = await stream({ messages: [{ role: 'user', content: 'hi' }] });
    const events = await readSse(res);
    check(
        '端到端：未配置时给出可读提示而不是崩',
        events.some((e) => e.type === 'error' && e.message.includes('还没有配置 AI 接口')),
        JSON.stringify(events[0])?.slice(0, 120),
    );
    check('端到端：未配置时也以 done 收尾', events.at(-1)?.type === 'done');
}

// 收尾：清空 AI 配置（与 verify.mjs 一致），别把假上游地址留在 dev KV 里
await setAi({ baseUrl: '', model: '', apiKey: '' });
mock.close();

console.log(`\n== AI 链路检查：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
