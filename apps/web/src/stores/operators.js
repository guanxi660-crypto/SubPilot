// 算子元数据缓存：类型表 / 内置模板 / 自定义模板 / 目标格式。
// 模块级 ref → 全局单例，多个页面共用一次请求。
// 拉不到时回落到内置兜底表，保证编辑器仍可用（不能因为一个接口挂了就整个页面空白）。

import { computed, ref } from 'vue';
import { api } from './auth.js';

export const operatorTypes = ref([]);
/** 内置模板（代码常量，只读） */
export const processPresets = ref([]);
/** 自定义模板（存在服务端快照里，可增删改，也是 AI 可编辑的对象） */
export const customTemplates = ref([]);
export const sceTargets = ref([]);
export const loaded = ref(false);

/** 内置 + 自定义，供下拉菜单统一渲染 */
export const allTemplates = computed(() => [
    ...processPresets.value.map((p) => ({ ...p, builtin: true })),
    ...customTemplates.value.map((p) => ({ ...p, builtin: false })),
]);

// 兜底表：接口不可用时仍要能添加算子。
// 这里只放「类型 + 默认参数」，不放 usage / example —— 那两份说明只在后端维护，
// 前端多一份就会各自漂移。说明面板拿不到 usage 时会回落到 desc（见 OperatorEditor）。
const FALLBACK_TYPES = [
    { type: 'Regex Filter', label: '正则筛选', icon: '⌕', desc: '按节点名称正则保留或排除', args: { regex: [], mode: 'exclude' } },
    { type: 'Region Filter', label: '地区筛选', icon: '🌍', desc: '按地区保留或排除', args: { regions: ['HK', 'JP'], mode: 'keep' } },
    { type: 'Type Filter', label: '协议筛选', icon: '⇄', desc: '按协议类型保留或排除', args: { types: ['vmess'], mode: 'keep' } },
    { type: 'Useless Filter', label: '无效节点过滤', icon: '⌀', desc: '丢掉缺字段或广告条目', args: {} },
    { type: 'Regex Rename', label: '正则重命名', icon: '✎', desc: '成对的「模式, 替换」', args: { regex: [] } },
    { type: 'Regex Delete', label: '名称正则修剪', icon: '✂', desc: '删掉名称里的匹配片段', args: { regex: [] } },
    { type: 'Name Prefix', label: '名称加前缀', icon: '⟨', desc: '给所有节点名加统一前缀', args: { value: '' } },
    { type: 'Name Suffix', label: '名称加后缀', icon: '⟩', desc: '给所有节点名加统一后缀', args: { value: '' } },
    { type: 'Sort Operator', label: '排序', icon: '⇅', desc: '按名称 / 协议 / 服务器 / 地区排序', args: { sort: 'asc', by: 'region' } },
    { type: 'Keyword Sort', label: '关键词排序', icon: '🔖', desc: '按关键词把节点分组排序，不改名', args: { keywords: ['IEPL', 'IPLC', '专线'], unmatched: 'bottom' } },
    { type: 'Handle Duplicate', label: '去重处理', icon: '⧉', desc: '重名加序号或删除', args: { action: 'rename' } },
    { type: 'Flag Operator', label: '国旗标识', icon: '🏳', desc: '按地区加国旗 emoji', args: { mode: 'add' } },
    { type: 'Limit Operator', label: '数量截断', icon: '✂', desc: '只保留前 N 个', args: { limit: 100, from: 'head' } },
    { type: 'Quick Settings', label: '快速设置', icon: '⚙', desc: '批量改 UDP / TFO / 跳过证书验证', args: { udp: true } },
];

export async function loadOperatorMeta(force = false) {
    if (loaded.value && !force) return;
    try {
        const res = await api('/api/operators');
        operatorTypes.value = res.data?.types || [];
        processPresets.value = res.data?.presets || [];
        customTemplates.value = res.data?.templates || [];
        sceTargets.value = res.data?.targets || [];
    } catch {
        operatorTypes.value = FALLBACK_TYPES;
        processPresets.value = [];
        customTemplates.value = [];
        sceTargets.value = [];
    } finally {
        if (!operatorTypes.value.length) operatorTypes.value = FALLBACK_TYPES;
        loaded.value = true;
    }
}

// ---- 自定义模板 CRUD ----
// 三个写接口都返回**更新后的完整自定义模板列表**（见 server 的写操作约定），
// 所以这里直接用返回值覆盖本地，不额外发读请求。

/** 新建模板。process 是算子链数组。 */
export async function createTemplate({ name, desc, process }) {
    const res = await api('/api/templates', {
        method: 'POST',
        body: JSON.stringify({ name, desc, process }),
    });
    customTemplates.value = res.data || [];
    return res.data || [];
}

/** 更新模板。patch 可含 name（改名）/ desc / process。 */
export async function updateTemplate(name, patch) {
    const res = await api(`/api/template/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
    customTemplates.value = res.data || [];
    return res.data || [];
}

/** 删除模板 */
export async function removeTemplate(name) {
    const res = await api(`/api/template/${encodeURIComponent(name)}`, {
        method: 'DELETE',
    });
    customTemplates.value = res.data || [];
    return res.data || [];
}

export function metaOf(type) {
    return operatorTypes.value.find((t) => t.type === type) || { type, label: type, icon: '◆', desc: '' };
}

/** 自定义名称上限，和后端 sanitizeProcess 的截断长度保持一致 */
export const OP_NAME_MAX = 40;

/**
 * 生成下一个「自定义N」名称 —— 「+ 自定义 JSON」新建算子时的默认名。
 *
 * 从 1 开始扫，取第一个没被占用的编号：删掉「自定义2」后再新建会补回 2，
 * 而不是一路涨到 自定义17。循环上界是 used.size + 1，保证一定有解。
 */
export function nextCustomName(list = []) {
    const used = new Set(
        (Array.isArray(list) ? list : [])
            .map((o) => String(o?.name ?? '').trim())
            .filter(Boolean),
    );
    for (let n = 1; n <= used.size + 1; n += 1) {
        const candidate = `自定义${n}`;
        if (!used.has(candidate)) return candidate;
    }
    return `自定义${used.size + 1}`;
}
