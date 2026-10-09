<template>
    <div class="p-6 md:p-10 max-w-7xl mx-auto pb-32">
        <div class="flex items-center gap-3">
            <button class="btn-ghost !py-1.5 text-xs" @click="back">‹ 返回</button>
            <h1 class="text-2xl font-bold">
                {{ isNew ? '新建订阅' : '编辑订阅' }}
                <span v-if="renamed" class="text-xs text-amber-300/90 ml-2">· 已改名</span>
            </h1>
        </div>

        <div v-if="loading" class="card p-8 mt-6 text-sm text-slate-500">加载中…</div>

        <template v-else>
            <!-- 左 1 右 2：左边实时预览，右边基本信息 + 脚本处理上下堆叠。
                 items-stretch（而非 items-start）：两列拉成等高，右列的底边
                 （JSON 脚本处理）才能和左列（实时预览）对齐 —— 此前 items-start
                 下两列各按内容高度走，预览卡片底边 443、JSON 卡片底边 1117，
                 差了近 700px，页面右下角像是被啃掉一块。
                 预览卡片因此要 flex-col，让节点列表 flex-1 吃掉多出来的高度。 -->
            <div class="grid lg:grid-cols-3 gap-4 mt-6 items-stretch">
                <!-- 预览 -->
                <div class="card p-6 fade-up lg:col-span-1 flex flex-col min-h-0">
                    <div class="flex items-center gap-3 flex-wrap shrink-0">
                        <div class="text-sm font-semibold">实时预览</div>
                        <span v-if="preview.loading" class="text-xs text-slate-500">解析中…</span>
                        <span v-else-if="preview.total !== null" class="text-xs text-slate-500">
                            {{ preview.total }} 个节点
                        </span>
                        <span v-if="preview.format" class="type-badge type-default">{{ preview.format }}</span>
                        <button class="btn-ghost !py-1 text-xs ml-auto" @click="runPreview" title="重新预览">↻</button>
                    </div>

                    <div v-if="preview.error" class="text-xs text-rose-300/80 mt-3 shrink-0">{{ preview.error }}</div>

                    <div v-if="preview.log?.length" class="mt-3 bg-panel2 rounded-xl p-3 text-[11px] font-mono text-slate-500 space-y-0.5 max-h-32 overflow-auto shrink-0">
                        <div v-for="(l, i) in preview.log" :key="i">{{ l }}</div>
                    </div>

                    <div class="mt-4 flex-1 min-h-0 overflow-auto">
                        <NodeList :nodes="preview.nodes" />
                    </div>
                </div>

                <!-- 基本信息 + 脚本处理 -->
                <div class="lg:col-span-2 flex flex-col gap-4 min-h-0">
                    <!-- 基本信息：留白比原先收一档（p-6→p-5、mt-4→mt-3），
                         给下面的 JSON 模块腾高度 —— 底边对齐靠的是这一列的总高。 -->
                    <div class="card p-5 fade-up shrink-0" style="--d:100ms">
                        <div class="text-sm font-semibold mb-3">基本信息</div>
                        <div class="grid md:grid-cols-2 gap-3">
                            <div>
                                <label class="text-xs text-slate-500">分发名称 <span class="text-rose-300">*</span></label>
                                <input v-model="form.name" class="input mt-1.5 font-mono" placeholder="例如 my-sub" />
                                <div class="text-[11px] text-slate-600 mt-1">
                                    该名称即分发路径，支持中文与空格，不能含 <code>/ \ ? # %</code> 等字符。
                                </div>
                                <div v-if="nameWarn" class="text-[11px] text-amber-300/90 mt-1 leading-relaxed">
                                    ⚠ 改名会保存为新订阅：旧链接 <code>/download/{{ originalName }}</code> 将失效，
                                    引用它的 {{ refCount }} 个组合会自动改为新名称。
                                </div>
                            </div>
                            <div>
                                <label class="text-xs text-slate-500">显示名（可选）</label>
                                <input v-model="form.displayName" class="input mt-1.5" placeholder="只影响界面称呼" />
                            </div>
                        </div>

                        <div class="mt-3">
                            <label class="text-xs text-slate-500">来源</label>
                            <div class="flex gap-2 mt-1.5">
                                <button
                                    v-for="s in SOURCES"
                                    :key="s.value"
                                    class="btn-ghost !py-1.5 text-xs"
                                    :class="form.source === s.value ? '!border-accent/60 !text-accent2' : ''"
                                    @click="form.source = s.value"
                                >{{ s.label }}</button>
                            </div>
                        </div>

                        <div v-if="form.source === 'remote'" class="mt-3">
                            <label class="text-xs text-slate-500">订阅地址（一行一个，可填多个）</label>
                            <NodeContentEditor
                                v-model="form.url"
                                class="mt-1.5 h-40"
                                placeholder="https://example.com/api/v1/client/subscribe?token=xxx"
                            />
                            <label class="text-xs text-slate-500 block mt-3">下载 UA（可选）</label>
                            <input v-model="form.ua" class="input mt-1.5 font-mono !text-xs" placeholder="例如 clash-verge/v2.0" />
                        </div>

                        <div v-else class="mt-3">
                            <label class="text-xs text-slate-500">节点内容（URI 列表或 Clash YAML）</label>
                            <NodeContentEditor
                                v-model="form.content"
                                class="mt-1.5 h-52"
                                placeholder="ss://... 或&#10;proxies:&#10;  - name: xxx"
                            />
                        </div>
                    </div>

                    <!-- 脚本处理：flex-1 撑满右列剩余高度，底边即与左侧预览卡片对齐 -->
                    <div class="card p-5 fade-up flex-1 flex flex-col min-h-0" style="--d:150ms">
                        <div class="flex items-center gap-2 flex-wrap shrink-0">
                            <div class="text-sm font-semibold">JSON 脚本处理</div>
                            <span class="text-[11px] text-slate-600">
                                对节点做筛选、排序、重命名；格式转换交给转换后端
                            </span>
                        </div>
                        <div class="mt-3 flex-1 min-h-0 flex flex-col">
                            <OperatorEditor v-model="form.process" fill />
                        </div>
                    </div>
                </div>
            </div>
        </template>

        <!-- 底部悬浮保存条 -->
        <div class="fixed bottom-16 md:bottom-0 inset-x-0 md:left-60 z-30 border-t border-line bg-panel/90 backdrop-blur px-6 py-3 flex items-center gap-3">
            <span class="text-xs text-slate-500">
                <template v-if="preview.total !== null">当前产出 {{ preview.total }} 个节点</template>
                <template v-else>尚未预览</template>
            </span>
            <div class="ml-auto flex gap-2">
                <button class="btn-ghost text-xs" @click="back">取消</button>
                <button class="btn-primary text-xs" :disabled="saving" @click="save">
                    {{ saving ? '保存中…' : '保存' }}
                </button>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { api } from '../stores/auth.js';
import OperatorEditor from '../components/OperatorEditor.vue';
import NodeList from '../components/NodeList.vue';
import NodeContentEditor from '../components/NodeContentEditor.vue';
import { loadOperatorMeta } from '../stores/operators.js';
import { validateName } from '../utils/name.js';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const SOURCES = [
    { value: 'remote', label: '远程订阅' },
    { value: 'local', label: '本地内容' },
];

const originalName = ref('');
const isNew = computed(() => !originalName.value);
const loading = ref(true);
const saving = ref(false);
const refCount = ref(0);
const allCollections = ref([]);

const form = reactive({
    name: '',
    displayName: '',
    source: 'remote',
    url: '',
    content: '',
    ua: '',
    process: [],
});

const preview = reactive({ loading: false, error: '', nodes: [], log: [], total: null, format: '' });

const renamed = computed(() => !isNew.value && form.name !== originalName.value);
const nameWarn = computed(() => renamed.value);

// ---- 脏检查：未保存离开时提示 ----
const dirty = ref(false);
let snapshot = '';

function snapshotOf() {
    return JSON.stringify(form);
}

function beforeUnload(e) {
    if (dirty.value) {
        e.preventDefault();
        e.returnValue = '';
    }
}

// ---- 预览（700ms 防抖）----
let timer = null;
function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(runPreview, 700);
}

async function runPreview() {
    const nameErr = validateName(form.name, { label: '分发名称' });
    if (nameErr) {
        preview.error = nameErr;
        preview.nodes = [];
        preview.total = 0;
        return;
    }
    if (form.source === 'remote' && !form.url.trim()) {
        preview.error = '请先填写订阅地址';
        preview.nodes = [];
        preview.total = 0;
        return;
    }
    if (form.source === 'local' && !form.content.trim()) {
        preview.error = '请先填写节点内容';
        preview.nodes = [];
        preview.total = 0;
        return;
    }
    preview.loading = true;
    preview.error = '';
    try {
        const res = await api('/api/preview/sub', {
            method: 'POST',
            body: JSON.stringify({ ...form }),
        });
        preview.nodes = res.data?.processed || [];
        preview.log = res.data?.log || [];
        preview.total = res.data?.total ?? preview.nodes.length;
        preview.format = res.data?.format || '';
    } catch (e) {
        preview.error = e.message;
        preview.nodes = [];
        preview.total = 0;
    } finally {
        preview.loading = false;
    }
}

// ---- 载入 ----
onMounted(async () => {
    await loadOperatorMeta();
    const raw = route.params.name;
    const name = raw === 'new' ? '' : decodeURIComponent(String(raw || ''));

    try {
        const [subsRes, colsRes] = await Promise.all([api('/api/subs'), api('/api/collections')]);
        const subs = subsRes.data || [];
        allCollections.value = colsRes.data || [];

        if (name) {
            const found = subs.find((s) => s.name === name);
            if (!found) {
                message.error(`订阅不存在：${name}`);
                router.replace('/subs');
                return;
            }
            originalName.value = found.name;
            Object.assign(form, {
                name: found.name,
                displayName: found.displayName || '',
                source: found.source === 'local' ? 'local' : 'remote',
                url: found.url || '',
                content: found.content || '',
                ua: found.ua || '',
                process: JSON.parse(JSON.stringify(found.process || [])),
            });
            refCount.value = allCollections.value.filter((c) => (c.subscriptions || []).includes(name)).length;
        }
    } catch (e) {
        if (/令牌|401/.test(e.message)) {
            router.push('/login');
            return;
        }
        message.error(e.message);
    } finally {
        loading.value = false;
        snapshot = snapshotOf();
        dirty.value = false;
        runPreview();
    }

    window.addEventListener('beforeunload', beforeUnload);
});

onBeforeUnmount(() => {
    clearTimeout(timer);
    window.removeEventListener('beforeunload', beforeUnload);
});

watch(
    () => snapshotOf(),
    (v) => {
        dirty.value = v !== snapshot;
        schedulePreview();
    },
);

// ---- 保存：两步（先 PATCH 落到旧名，再 rename）----
async function save() {
    const nameErr = validateName(form.name, { label: '分发名称' });
    if (nameErr) return message.error(nameErr);
    if (form.source === 'remote' && !form.url.trim()) return message.error('请填写订阅地址');
    if (form.source === 'local' && !form.content.trim()) return message.error('请填写节点内容');

    saving.value = true;
    try {
        if (isNew.value) {
            const res = await api('/api/subs', { method: 'POST', body: JSON.stringify({ ...form }) });
            snapshot = snapshotOf();
            dirty.value = false;
            message.success('已创建');
            router.replace(`/subs/edit/${encodeURIComponent(form.name)}`);
            originalName.value = form.name;
            void res;
        } else {
            // 先把其余字段落到旧名称下（后端 PATCH 不带 name）
            await api(`/api/sub/${encodeURIComponent(originalName.value)}`, {
                method: 'PATCH',
                body: JSON.stringify({ ...form, name: originalName.value }),
            });
            if (form.name !== originalName.value) {
                await api(`/api/sub/${encodeURIComponent(originalName.value)}/rename`, {
                    method: 'POST',
                    body: JSON.stringify({ name: form.name }),
                });
                originalName.value = form.name;
                router.replace(`/subs/edit/${encodeURIComponent(form.name)}`);
            }
            snapshot = snapshotOf();
            dirty.value = false;
            message.success('已保存');
        }
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    } finally {
        saving.value = false;
    }
}

function back() {
    if (dirty.value && !confirm('有未保存的改动，确定离开？')) return;
    dirty.value = false;
    router.push('/subs');
}
</script>
