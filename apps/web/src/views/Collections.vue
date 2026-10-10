<template>
    <div class="p-6 md:p-10 max-w-6xl mx-auto">
        <div class="flex items-center justify-between gap-3">
            <div>
                <h1 class="text-2xl font-bold">组合订阅</h1>
                <p class="text-slate-500 text-sm mt-1">把多个订阅合并成一个产出，可叠加组合层脚本</p>
            </div>
            <button class="btn-primary whitespace-nowrap" @click="openNew">+ 新建组合</button>
        </div>

        <draggable
            v-if="collections.length"
            v-model="collections"
            item-key="name"
            handle=".drag-handle"
            :animation="200"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            drag-class="sortable-drag"
            class="grid md:grid-cols-2 gap-4 mt-6"
            @end="onDragEnd"
        >
            <template #item="{ element: c, index: idx }">
                <div :key="c.name" class="card card-hover p-5 group fade-up" :style="`--d:${Math.min(idx, 8) * 50}ms`">
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <span
                                class="drag-handle shrink-0 w-6 h-6 rounded-lg text-slate-500 hover:text-accent2 hover:bg-panel2 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
                                title="拖动排序"
                            >⠿</span>
                            <div class="font-semibold truncate">{{ c.displayName || c.name }}</div>
                        </div>
                        <span class="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-line text-slate-400">
                            {{ (c.subscriptions || []).length }} 订阅
                        </span>
                    </div>
                    <div class="text-xs text-slate-500 mt-2 flex flex-wrap gap-1">
                        <span
                            v-for="n in (c.subscriptions || []).slice(0, 5)"
                            :key="n"
                            class="px-1.5 py-0.5 rounded-md bg-panel2 border border-line font-mono truncate max-w-[9rem]"
                        >{{ n }}</span>
                        <span v-if="(c.subscriptions || []).length > 5" class="px-1.5 py-0.5 text-slate-600">
                            +{{ c.subscriptions.length - 5 }}
                        </span>
                    </div>
                    <div class="text-xs text-slate-600 mt-2">脚本 {{ c.process?.length || 0 }} 步</div>

                    <div class="flex items-center gap-2 mt-4 opacity-70 group-hover:opacity-100 transition flex-wrap">
                        <button class="btn-ghost !py-1.5 text-xs" @click="preview(c)">预览</button>
                        <n-dropdown trigger="click" :options="copyTargets" @select="(t) => copyCol(c, t)">
                            <button class="btn-ghost !py-1.5 text-xs">复制订阅</button>
                        </n-dropdown>
                        <button class="btn-ghost !py-1.5 text-xs" @click="openEdit(c)">编辑</button>
                        <TgPushButton kind="col" :name="c.name" :label="c.displayName || c.name" />
                        <button class="btn-ghost !py-1.5 text-xs !text-rose-300/80 ml-auto" @click="remove(c)">删除</button>
                    </div>
                </div>
            </template>
        </draggable>

        <EmptyState
            v-else-if="!loading"
            icon="⊕"
            title="还没有组合订阅"
            hint="把多个订阅合并为一个产出，可叠加组合层脚本"
        >
            <button class="btn-primary mt-4 !py-1.5 text-xs" @click="openNew">+ 新建组合</button>
        </EmptyState>

        <!-- 编辑弹窗 -->
        <div
            v-if="editor.open"
            class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-auto py-10 px-4"
            @click.self="closeEditor"
        >
            <div class="card w-full max-w-3xl p-6">
                <div class="flex items-center justify-between">
                    <div class="font-semibold">{{ editor.isNew ? '新建组合' : '编辑组合' }}</div>
                    <button class="btn-ghost !py-1" @click="closeEditor">关闭</button>
                </div>

                <div class="grid md:grid-cols-2 gap-4 mt-4">
                    <div>
                        <label class="text-xs text-slate-500">分发名称 <span class="text-rose-300">*</span></label>
                        <input
                            v-model="editor.form.name"
                            class="input mt-1.5 font-mono"
                            :disabled="!editor.isNew"
                            placeholder="例如 my-collection"
                        />
                        <div v-if="!editor.isNew" class="text-[11px] text-slate-600 mt-1">
                            该名称即分发路径，创建后不可改（改了旧链接会失效）
                        </div>
                    </div>
                    <div>
                        <label class="text-xs text-slate-500">显示名（可选）</label>
                        <input v-model="editor.form.displayName" class="input mt-1.5" />
                    </div>
                </div>

                <div class="mt-4">
                    <label class="text-xs text-slate-500">
                        选择订阅（{{ editor.form.subscriptions.length }} / {{ subs.length }}）
                    </label>
                    <div v-if="!subs.length" class="text-xs text-amber-300/90 mt-2">请先创建单条订阅</div>
                    <div v-else class="flex flex-wrap gap-2 mt-2 max-h-40 overflow-auto p-1">
                        <button
                            v-for="s in subs"
                            :key="s.name"
                            class="px-3 py-1.5 rounded-xl text-xs border transition"
                            :class="editor.form.subscriptions.includes(s.name)
                                ? 'border-accent/60 bg-accent/15 text-white'
                                : 'border-line bg-panel2 text-slate-400 hover:text-slate-200'"
                            @click="toggleSub(s.name)"
                        >{{ s.displayName || s.name }}</button>
                    </div>
                </div>

                <div class="mt-5">
                    <div class="text-xs text-slate-500 mb-2">
                        组合层脚本（作用在合并后的全部节点上）
                    </div>
                    <OperatorEditor v-model="editor.form.process" />
                </div>

                <div class="flex items-center gap-3 mt-6">
                    <span class="text-xs text-slate-500">
                        <template v-if="editor.preview.total !== null">
                            合并后 {{ editor.preview.total }} 个节点
                        </template>
                        <template v-else>点「预览」查看合并结果</template>
                    </span>
                    <div class="ml-auto flex gap-2">
                        <button class="btn-ghost text-xs" :disabled="editor.preview.loading" @click="runColPreview">
                            {{ editor.preview.loading ? '解析中…' : '预览' }}
                        </button>
                        <button class="btn-primary text-xs" :disabled="editor.saving" @click="saveEditor">
                            {{ editor.saving ? '保存中…' : '保存' }}
                        </button>
                    </div>
                </div>

                <div v-if="editor.preview.error" class="text-xs text-rose-300/80 mt-3">{{ editor.preview.error }}</div>
                <div v-if="editor.preview.log?.length" class="mt-3 bg-panel2 rounded-xl p-3 text-[11px] font-mono text-slate-500 space-y-0.5 max-h-32 overflow-auto">
                    <div v-for="(l, i) in editor.preview.log" :key="i">{{ l }}</div>
                </div>
                <div v-if="editor.preview.nodes?.length" class="mt-3 max-h-[40vh] overflow-auto">
                    <NodeList :nodes="editor.preview.nodes" />
                </div>
            </div>
        </div>

        <!-- 预览弹窗 -->
        <div
            v-if="previewData"
            class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-auto py-10 px-4"
            @click.self="previewData = null"
        >
            <div class="card w-full max-w-3xl p-6">
                <div class="flex items-center justify-between">
                    <div class="font-semibold">
                        预览：{{ previewData.name }}
                        <span class="text-xs text-slate-500 ml-2">{{ previewData.processed?.length ?? 0 }} 节点</span>
                    </div>
                    <button class="btn-ghost !py-1" @click="previewData = null">关闭</button>
                </div>
                <div v-if="previewData.log?.length" class="mt-3 bg-panel2 rounded-xl p-3 text-[11px] font-mono text-slate-500 space-y-0.5 max-h-32 overflow-auto">
                    <div v-for="(l, i) in previewData.log" :key="i">{{ l }}</div>
                </div>
                <div class="mt-4 max-h-[55vh] overflow-auto">
                    <NodeList :nodes="previewData.processed || []" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, useDialog, NDropdown } from 'naive-ui';
import draggable from 'vuedraggable';
import { api } from '../stores/auth.js';
import EmptyState from '../components/EmptyState.vue';
import NodeList from '../components/NodeList.vue';
import TgPushButton from '../components/TgPushButton.vue';
import OperatorEditor from '../components/OperatorEditor.vue';
import { loadOperatorMeta } from '../stores/operators.js';
import { validateName } from '../utils/name.js';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const collections = ref([]);
const subs = ref([]);
const loading = ref(true);
const previewData = ref(null);
const copyTargets = ref([]);

const editor = reactive({
    open: false,
    isNew: true,
    originalName: '',
    saving: false,
    form: { name: '', displayName: '', subscriptions: [], process: [] },
    preview: { loading: false, error: '', nodes: [], log: [], total: null },
});

function buildCopyTargets() {
    // 只保留两个有用的目标：v2ray 通用（raw，服务端本地产出，不依赖转换后端，
    // 见 convert.js 的 target=raw 分支）与 Clash / Mihomo。
    // singbox / shadowrocket / vless / ss 等其余格式用不上，已移除（2026-10-10）。
    copyTargets.value = [
        { label: 'v2ray通用', key: 'raw' },
        { label: 'Clash / Mihomo', key: 'clash' },
    ];
}

async function onDragEnd() {
    try {
        const res = await api('/api/sort/collections', {
            method: 'POST',
            body: JSON.stringify(collections.value.map((c) => c.name)),
        });
        collections.value = res.data || collections.value;
    } catch (e) {
        message.error(`排序保存失败：${e.message}`);
        load();
    }
}

async function load() {
    loading.value = true;
    try {
        const [c, s] = await Promise.all([api('/api/collections'), api('/api/subs')]);
        collections.value = c.data || [];
        subs.value = s.data || [];
    } catch (e) {
        if (/令牌|401/.test(e.message)) {
            router.push('/login');
            return;
        }
        message.error(e.message);
    } finally {
        loading.value = false;
    }
}

function openNew() {
    editor.isNew = true;
    editor.originalName = '';
    editor.form = { name: '', displayName: '', subscriptions: [], process: [] };
    editor.preview = { loading: false, error: '', nodes: [], log: [], total: null };
    editor.open = true;
}

function openEdit(c) {
    editor.isNew = false;
    editor.originalName = c.name;
    editor.form = {
        name: c.name,
        displayName: c.displayName || '',
        subscriptions: [...(c.subscriptions || [])],
        process: JSON.parse(JSON.stringify(c.process || [])),
    };
    editor.preview = { loading: false, error: '', nodes: [], log: [], total: null };
    editor.open = true;
}

function closeEditor() {
    editor.open = false;
}

function toggleSub(name) {
    const i = editor.form.subscriptions.indexOf(name);
    if (i >= 0) editor.form.subscriptions.splice(i, 1);
    else editor.form.subscriptions.push(name);
}

async function runColPreview() {
    if (!editor.form.subscriptions.length) {
        editor.preview.error = '请至少选择一个订阅';
        return;
    }
    editor.preview.loading = true;
    editor.preview.error = '';
    try {
        const res = await api('/api/preview/collection', {
            method: 'POST',
            body: JSON.stringify({
                subscriptions: editor.form.subscriptions,
                process: editor.form.process,
            }),
        });
        editor.preview.nodes = res.data?.processed || [];
        editor.preview.log = res.data?.log || [];
        editor.preview.total = res.data?.total ?? editor.preview.nodes.length;
    } catch (e) {
        editor.preview.error = e.message;
        editor.preview.nodes = [];
        editor.preview.total = 0;
    } finally {
        editor.preview.loading = false;
    }
}

async function saveEditor() {
    const name = String(editor.form.name || '').trim();
    const nameErr = validateName(name, { label: '分发名称' });
    if (nameErr) return message.error(nameErr);
    if (!editor.form.subscriptions.length) return message.error('请至少选择一个订阅');

    editor.saving = true;
    try {
        if (editor.isNew) {
            const res = await api('/api/collections', {
                method: 'POST',
                body: JSON.stringify(editor.form),
            });
            collections.value = res.data || collections.value;
            message.success('已创建');
        } else {
            const res = await api(`/api/collection/${encodeURIComponent(editor.originalName)}`, {
                method: 'PATCH',
                body: JSON.stringify(editor.form),
            });
            collections.value = res.data || collections.value;
            message.success('已保存');
        }
        editor.open = false;
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    } finally {
        editor.saving = false;
    }
}

async function preview(c) {
    try {
        const res = await api('/api/preview/collection', {
            method: 'POST',
            body: JSON.stringify({ subscriptions: c.subscriptions, process: c.process }),
        });
        previewData.value = {
            name: c.displayName || c.name,
            processed: res.data?.processed || [],
            log: res.data?.log || [],
        };
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    }
}

async function copyCol(c, target) {
    try {
        // 服务端生成，带派生的只读分发密钥（?ft=），不含管理令牌
        const qs = new URLSearchParams({ kind: 'col', name: c.name });
        if (target) qs.set('target', target);
        const res = await api(`/api/link?${qs.toString()}`);
        await navigator.clipboard.writeText(res.data.link);
        const label = copyTargets.value.find((x) => x.key === target)?.label || 'v2ray通用';
        message.success(`已复制「${label}」链接`);
    } catch (e) {
        message.error(`生成链接失败：${e.message}`);
    }
}

function remove(c) {
    dialog.warning({
        title: '删除组合',
        content: `确定删除组合「${c.displayName || c.name}」？不会影响成员订阅本身。`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: async () => {
            try {
                const res = await api(`/api/collection/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
                collections.value = res.data || [];
                message.success('已删除');
            } catch (e) {
                message.error(e.message);
            }
        },
    });
}

onMounted(async () => {
    await loadOperatorMeta();
    buildCopyTargets();
    load();
});
</script>
