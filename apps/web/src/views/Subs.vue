<template>
    <div class="p-6 md:p-10 max-w-6xl mx-auto">
        <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
                <h1 class="text-2xl font-bold">订阅管理</h1>
                <p class="text-slate-500 text-sm mt-1">订阅的解析、JSON 脚本处理与分发</p>
            </div>
            <div class="flex gap-2 shrink-0">
                <div class="flex gap-1 shrink-0 rounded-lg p-0.5 border border-line bg-panel/40">
                    <button
                        class="px-2 py-1 text-xs rounded-md transition"
                        :class="cols === 1 ? 'bg-accent/20 text-accent2' : 'text-slate-400 hover:text-slate-200'"
                        title="单列显示"
                        @click="setCols(1)"
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="12" rx="2" /></svg>
                    </button>
                    <button
                        class="px-2 py-1 text-xs rounded-md transition"
                        :class="cols === 2 ? 'bg-accent/20 text-accent2' : 'text-slate-400 hover:text-slate-200'"
                        title="双列显示"
                        @click="setCols(2)"
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="6" height="12" rx="1.5" /><rect x="9" y="2" width="6" height="12" rx="1.5" /></svg>
                    </button>
                </div>
                <button class="btn-primary whitespace-nowrap" @click="router.push('/subs/edit/new')">
                    + 新建订阅
                </button>
            </div>
        </div>

        <draggable
            v-if="subs.length"
            v-model="subs"
            item-key="name"
            handle=".drag-handle"
            :animation="200"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            drag-class="sortable-drag"
            :class="[cols === 2 ? 'md:grid-cols-2' : 'grid-cols-1', 'grid gap-4 mt-6']"
            @end="onDragEnd"
        >
            <template #item="{ element: s, index: idx }">
                <div :key="s.name" class="card card-hover p-5 group fade-up" :style="`--d:${Math.min(idx, 8) * 50}ms`">
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <span
                                class="drag-handle shrink-0 w-6 h-6 rounded-lg text-slate-500 hover:text-accent2 hover:bg-panel2 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
                                title="拖动排序"
                            >⠿</span>
                            <div class="font-semibold truncate">{{ s.displayName || s.name }}</div>
                        </div>
                        <span
                            class="shrink-0 text-[10px] px-2 py-0.5 rounded-full border"
                            :class="s.source === 'local'
                                ? 'border-emerald-500/40 text-emerald-300'
                                : 'border-sky-500/40 text-sky-300'"
                        >{{ s.source === 'local' ? '本地' : '远程' }}</span>
                    </div>

                    <div class="text-xs text-slate-500 mt-1 truncate" :title="s.url">
                        {{ s.source === 'local' ? '(本地内容)' : s.url || '(未填写地址)' }}
                    </div>
                    <div class="text-xs text-slate-600 mt-2 flex items-center gap-2">
                        <span>脚本 {{ s.process?.length || 0 }} 步</span>
                        <span v-if="s.ua" class="truncate">· UA {{ s.ua }}</span>
                    </div>

                    <div class="flex items-center gap-2 mt-4 opacity-70 group-hover:opacity-100 transition flex-wrap">
                        <button class="btn-ghost !py-1.5 text-xs whitespace-nowrap shrink-0" @click="preview(s)">预览</button>
                        <button class="btn-ghost !py-1.5 text-xs whitespace-nowrap shrink-0" title="编辑后的订阅：URI 来源输出 v2ray 通用订阅，clash 来源输出 clash YAML，不转换" @click="copySub(s)">复制订阅</button>
                        <button class="btn-ghost !py-1.5 text-xs whitespace-nowrap shrink-0" title="下载编辑后的订阅文件（URI 订阅存 .txt，clash 来源存 .yaml）" @click="download(s)">下载</button>
                        <button class="btn-ghost !py-1.5 text-xs whitespace-nowrap shrink-0" @click="router.push(`/subs/edit/${encodeURIComponent(s.name)}`)">编辑</button>
                        <TgPushButton kind="sub" :name="s.name" :label="s.displayName || s.name" />
                        <button
                            class="btn-ghost !py-1.5 text-xs !text-rose-300/80 whitespace-nowrap shrink-0 ml-auto"
                            @click="remove(s)"
                        >删除</button>
                    </div>
                </div>
            </template>
        </draggable>

        <EmptyState
            v-if="!subs.length && !loading"
            icon="▤"
            title="还没有订阅"
            hint="新建订阅后即可用 JSON 脚本筛选、排序、重命名节点"
        >
            <button class="btn-primary mt-4 !py-1.5 text-xs" @click="router.push('/subs/edit/new')">+ 新建订阅</button>
        </EmptyState>

        <!-- 预览弹窗 -->
        <div
            v-if="previewData"
            class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-auto py-10 px-4"
            @click.self="previewData = null"
        >
            <div class="card w-full max-w-3xl p-6">
                <div class="flex items-center justify-between gap-3 flex-wrap">
                    <div class="font-semibold">
                        预览：{{ previewData.name }}
                        <span class="text-xs text-slate-500 ml-2">{{ previewData.processed?.length ?? 0 }} 节点</span>
                    </div>
                    <div class="flex gap-2">
                        <button class="btn-ghost !py-1 text-xs" @click="router.push(`/subs/edit/${encodeURIComponent(previewData.rawName)}`)">
                            去编辑
                        </button>
                        <button class="btn-ghost !py-1" @click="previewData = null">关闭</button>
                    </div>
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
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, useDialog } from 'naive-ui';
import draggable from 'vuedraggable';
import { api } from '../stores/auth.js';
import { downloadFeed } from '../utils/download.js';
import EmptyState from '../components/EmptyState.vue';
import NodeList from '../components/NodeList.vue';
import TgPushButton from '../components/TgPushButton.vue';
import { loadOperatorMeta } from '../stores/operators.js';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const subs = ref([]);
const loading = ref(true);
const previewData = ref(null);

const COLS_KEY = 'sp_subs_cols';
const cols = ref(localStorage.getItem(COLS_KEY) === '2' ? 2 : 1);
function setCols(n) {
    cols.value = n === 2 ? 2 : 1;
    localStorage.setItem(COLS_KEY, String(cols.value));
}

/** 复制订阅：一条链接通吃所有客户端（Sub-Store 模式）。
 *  分发通道不转换 —— URI 来源输出 v2ray 通用订阅（base64 URI），
 *  clash 来源输出本地 clash YAML；target 参数已被后端忽略（2026-10-10）。 */
async function copySub(s) {
    try {
        // 链接由服务端生成：里面带的是**派生的只读分发密钥**（?ft=），
        // 不是管理令牌 —— 后者粘进客户端等于把管理员凭据交出去。
        const qs = new URLSearchParams({ kind: 'sub', name: s.name });
        const res = await api(`/api/link?${qs.toString()}`);
        await navigator.clipboard.writeText(res.data.link);
        message.success('已复制订阅链接（编辑后的订阅，不转换，全客户端可导入）');
    } catch (e) {
        message.error(`生成链接失败：${e.message}`);
    }
}

async function load() {
    loading.value = true;
    try {
        const res = await api('/api/subs');
        subs.value = res.data || [];
    } catch (e) {
        if (/令牌|401/.test(e.message)) {
            router.push('/login');
            return;
        }
        message.error(`加载订阅失败：${e.message}`);
    } finally {
        loading.value = false;
    }
}

async function onDragEnd() {
    try {
        const res = await api('/api/sort/subs', {
            method: 'POST',
            body: JSON.stringify(subs.value.map((s) => s.name)),
        });
        subs.value = res.data || subs.value;
    } catch (e) {
        message.error(`排序保存失败：${e.message}`);
        load();
    }
}

async function preview(s) {
    try {
        const res = await api('/api/preview/sub', {
            method: 'POST',
            body: JSON.stringify(s),
        });
        previewData.value = {
            name: s.displayName || s.name,
            rawName: s.name,
            processed: res.data?.processed || [],
            log: res.data?.log || [],
        };
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    }
}

/** 下载编辑后的订阅（URI 订阅 .txt / clash 来源 .yaml，见 utils/download.js） */
async function download(s) {
    try {
        await downloadFeed('sub', s.name, s.displayName || s.name);
        message.success('已开始下载');
    } catch (e) {
        message.error(`下载失败：${e.message}`);
    }
}

function remove(s) {
    dialog.warning({
        title: '删除订阅',
        content: `确定删除订阅「${s.displayName || s.name}」？该操作不可恢复，引用它的组合会自动摘掉这一项。`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: async () => {
            try {
                const res = await api(`/api/sub/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
                subs.value = res.data || [];
                message.success('已删除');
            } catch (e) {
                message.error(e.message);
            }
        },
    });
}

onMounted(async () => {
    await loadOperatorMeta();
    load();
});
</script>
