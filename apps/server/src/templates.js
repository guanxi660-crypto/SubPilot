// 自定义算子模板：把一条调好的算子链存起来复用，并且**允许 AI 直接编辑**。
//
// 为什么不放浏览器 localStorage：
//   AI 助手的调用发生在服务端（API Key 不下发到浏览器，见 ai.js 的说明），
//   模板若只存在某个浏览器里，换台设备就没了，AI 也没法把它当成可编辑的对象。
//   放进快照（KV）之后，模板和订阅/组合同源：一次备份带走、跨设备一致。
//
// 与内置模板的关系：
//   内置模板是代码常量（operators.js 的 PROCESS_PRESETS），只读、随版本升级。
//   自定义模板存在快照里，可增删改。两者**不允许重名** —— 下拉菜单里同名两项，
//   用户点哪个都得靠猜，属于设计事故，不如在写入时就拒掉。

import { ok, fail, isPlainObject, validateName, nowIso } from './util.js';
import { loadSnapshot, mutate } from './storage.js';
import { PROCESS_PRESETS } from './operators.js';

/** 单条模板最多几个算子：够复杂了，再多基本是模型幻觉堆出来的 */
const MAX_OPS = 100;
/** 模板总数上限：快照是单键存储，塞太多会拖慢每次读写 */
const MAX_TEMPLATES = 50;
const MAX_DESC = 200;
const MAX_NAME = 40;
/** 单个算子的自定义显示名上限（订阅编辑页的「自定义名称」） */
const MAX_OP_NAME = 40;

/**
 * 收敛算子链：只保留 { type, args, disabled, name } 四个字段。
 * 外部（含 AI）传进来的对象可能是任意形状 —— 多出来的键会一路带到 SCE 的
 * 请求体里，所以在这里就砍掉，不给它机会。
 *
 * name 是白名单里的例外：它只是给人看的显示名（订阅编辑页「+ 自定义 JSON」
 * 默认给「自定义1/2/3…」），SCE 按 type 查处理函数，多一个 name 会被忽略。
 * 但不放行的话，「存为模板 → 套用回来」会把用户起的名字剥掉，又变回算子本名。
 */
export function sanitizeProcess(input) {
    if (!Array.isArray(input)) return null;
    const out = [];
    // 这里**不截断**。此前写的是 input.slice(0, MAX_OPS)，超出的算子被静默丢掉 ——
    // 用户看到「保存成功」，链子却短了一截，回头看根本找不到丢在哪一步。
    // 上限改由调用方（buildTemplate）显式报错拦下。
    for (const raw of input) {
        if (!isPlainObject(raw)) return null;
        const type = String(raw.type ?? '').trim();
        if (!type) return null;
        const item = { type };
        // args 必须是对象；缺省给 {}，避免 SCE 侧拿到 undefined 报错
        if (raw.args === undefined || raw.args === null) item.args = {};
        else if (isPlainObject(raw.args)) item.args = JSON.parse(JSON.stringify(raw.args));
        else return null;
        if (raw.disabled) item.disabled = true;
        // 自定义显示名：可选。空串 / 非字符串一律当没有，别把 null 带进请求体
        const opName = String(raw.name ?? '').trim().slice(0, MAX_OP_NAME);
        if (opName) item.name = opName;
        out.push(item);
    }
    return out;
}

/** 内置模板名集合 —— 自定义模板不许撞名 */
function builtinNames() {
    return new Set(PROCESS_PRESETS.map((p) => p.name));
}

/**
 * 校验并规范化一份模板。
 * prev 存在表示这是「改」：未提供的字段沿用旧值。
 * 返回 { error } 或 { item }。
 */
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

/**
 * GET    /api/templates       → { builtin, custom }
 * POST   /api/templates       → 新建
 * PATCH  /api/template/:name  → 更新（可改名）
 * DELETE /api/template/:name  → 删除
 *
 * body 由 handleApi 统一解析后传进来，这里不再读 request。
 */
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
