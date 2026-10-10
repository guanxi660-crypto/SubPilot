import { ok, fail, isPlainObject, validateName, nowIso } from './util.js';
import { loadSnapshot, mutate } from './storage.js';
import { PROCESS_PRESETS } from './operators.js';

const MAX_OPS = 100;

const MAX_TEMPLATES = 50;
const MAX_DESC = 200;
const MAX_NAME = 40;

const MAX_OP_NAME = 40;

export function sanitizeProcess(input) {
    if (!Array.isArray(input)) return null;
    const out = [];
    
    
    
    for (const raw of input) {
        if (!isPlainObject(raw)) return null;
        const type = String(raw.type ?? '').trim();
        if (!type) return null;
        const item = { type };
        
        if (raw.args === undefined || raw.args === null) item.args = {};
        else if (isPlainObject(raw.args)) item.args = JSON.parse(JSON.stringify(raw.args));
        else return null;
        if (raw.disabled) item.disabled = true;
        
        const opName = String(raw.name ?? '').trim().slice(0, MAX_OP_NAME);
        if (opName) item.name = opName;
        out.push(item);
    }
    return out;
}

function builtinNames() {
    return new Set(PROCESS_PRESETS.map((p) => p.name));
}

function buildTemplate(body, prev = null) {
    const name = String(body.name ?? prev?.name ?? '').trim();
    const nameErr = validateName(name, { maxLen: MAX_NAME });
    if (nameErr) return { error: `模板${nameErr}` };
    if (builtinNames().has(name)) return { error: `「${name}」是内置模板名，换一个` };

    const desc = String(body.desc ?? prev?.desc ?? '').trim().slice(0, MAX_DESC);

    let process;
    if (body.process === undefined) {
        if (!prev) return { error: '模板内容（process）不能为空' };
        process = prev.process;
    } else {
        if (Array.isArray(body.process) && body.process.length > MAX_OPS) {
            return { error: `算子链最多 ${MAX_OPS} 个算子，当前 ${body.process.length} 个` };
        }
        process = sanitizeProcess(body.process);
        if (process === null) return { error: '算子链格式不对：应为 [{ type, args }] 数组' };
        if (!process.length) return { error: '模板至少要有一个算子' };
    }

    return {
        item: {
            name,
            desc,
            process,
            createdAt: prev?.createdAt || nowIso(),
            updatedAt: nowIso(),
        },
    };
}

export async function handleTemplates(env, { method, seg, body }) {
    if (seg[0] === 'templates' && method === 'GET') {
        const snap = await loadSnapshot(env);
        return ok({ builtin: PROCESS_PRESETS, custom: snap.templates });
    }

    if (seg[0] === 'templates' && method === 'POST') {
        const { item, error } = buildTemplate(body);
        if (error) return fail(error, 400);
        const { snap, result } = await mutate(env, (s) => {
            if (s.templates.length >= MAX_TEMPLATES) {
                return { error: `自定义模板最多 ${MAX_TEMPLATES} 个，先删掉几个` };
            }
            if (s.templates.some((t) => t.name === item.name)) {
                return { error: `模板名已被占用：${item.name}`, status: 409 };
            }
            s.templates.unshift(item);
            return {};
        });
        if (result.error) return fail(result.error, result.status || 400);
        return ok(snap.templates, 201);
    }

    if (seg[0] === 'template' && seg.length === 2) {
        const name = decodeURIComponent(seg[1]);

        if (method === 'PATCH') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.templates.findIndex((t) => t.name === name);
                if (idx < 0) return { error: `模板不存在：${name}`, status: 404 };
                const built = buildTemplate(body, s.templates[idx]);
                if (built.error) return { error: built.error, status: 400 };
                if (built.item.name !== name && s.templates.some((t) => t.name === built.item.name)) {
                    return { error: `模板名已被占用：${built.item.name}`, status: 409 };
                }
                s.templates[idx] = built.item;
                return {};
            });
            if (result.error) return fail(result.error, result.status || 400);
            return ok(snap.templates);
        }

        if (method === 'DELETE') {
            const { snap, result } = await mutate(env, (s) => {
                const idx = s.templates.findIndex((t) => t.name === name);
                if (idx < 0) return { error: `模板不存在：${name}`, status: 404 };
                s.templates.splice(idx, 1);
                return {};
            });
            if (result.error) return fail(result.error, result.status || 404);
            return ok(snap.templates);
        }
    }

    return fail(`未知模板接口：${method} ${seg.join('/')}`, 404);
}
