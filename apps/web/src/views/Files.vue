<template>
    <div class="p-6 md:p-10 max-w-6xl mx-auto">
        <div class="flex items-center justify-between gap-3 flex-wrap">
            <div>
                <h1 class="text-2xl font-bold">文件</h1>
                <p class="text-slate-500 text-sm mt-1">
                    规则集 / 模板 / 片段，可生成分享链接对外分发
                </p>
            </div>
            <div class="flex gap-2">
                <label class="btn-ghost cursor-pointer text-sm">
                    ⇧ 上传文件
                    <input type="file" class="hidden" multiple @change="onUpload" />
                </label>
                <button class="btn-primary whitespace-nowrap" @click="openNew">+ 新建文件</button>
            </div>
        </div>

        <draggable
            v-if="files.length"
            v-model="files"
            item-key="name"
            handle=".drag-handle"
            :animation="200"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            drag-class="sortable-drag"
            class="grid md:grid-cols-2 gap-4 mt-6"
            @end="onDragEnd"
        >
            <template #item="{ element: f, index: idx }">
                <div :key="f.name" class="card card-hover p-5 group fade-up" :style="`--d:${Math.min(idx, 8) * 50}ms`">
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <span
                                class="drag-handle shrink-0 w-6 h-6 rounded-lg text-slate-500 hover:text-accent2 hover:bg-panel2 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
                                title="拖动排序"
                            >⠿</span>
                            <div class="font-semibold truncate">{{ f.displayName || f.name }}</div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="type-badge type-default">{{ extOf(f.name) || 'txt' }}</span>
                            <span
                                class="text-[10px] px-2 py-0.5 rounded-full border"
                                :class="f.source === 'remote'
                                    ? 'border-sky-500/40 text-sky-300'
                                    : 'border-emerald-500/40 text-emerald-300'"
                            >{{ f.source === 'remote' ? '远程' : '本地' }}</span>
                        </div>
                    </div>

                    <div class="text-xs text-slate-500 mt-1 truncate font-mono">{{ f.name }}</div>
                    <div class="text-xs text-slate-600 mt-2">
                        <span v-if="f.source === 'remote'">{{ f.url }}</span>
                        <span v-else>{{ fmtSize(f.size) }}</span>
                    </div>

                    <div class="flex items-center gap-2 mt-4 opacity-70 group-hover:opacity-100 transition flex-wrap">
                        <button class="btn-ghost !py-1.5 text-xs" @click="openEdit(f)">编辑</button>
                        <button class="btn-ghost !py-1.5 text-xs" title="下载文件正文（远程文件直接打开其地址）" @click="download(f)">下载</button>
                        <button class="btn-ghost !py-1.5 text-xs" @click="openGen(f)">生成链接</button>
                        <button class="btn-ghost !py-1.5 text-xs" @click="togglePanel(f)">分享链接</button>
                        <TgPushButton kind="file" :name="f.name" :label="f.displayName || f.name" />
                        <button class="btn-ghost !py-1.5 text-xs !text-rose-300/80 ml-auto" @click="remove(f)">删除</button>
                    </div>

                    <!-- 点「分享链接」在本卡片下方展开，不再单开列表卡片 -->
                    <div v-if="panelFor === f.name" class="mt-3 pt-3 border-t border-line">
                        <ShareList :shares="sharesOf(f.name)" @delete="delShare" />
                    </div>
                </div>
            </template>
        </draggable>

        <EmptyState
            v-else-if="!loading"
            icon="▦"
            title="还没有文件"
            hint="存放规则集、模板、片段；生成分享链接后可给别人直接拉取"
        >
            <button class="btn-primary mt-4 !py-1.5 text-xs" @click="openNew">+ 新建文件</button>
        </EmptyState>

        <!-- 编辑抽屉 -->
        <div
            v-if="drawer.open"
            class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-end"
            @click.self="drawer.open = false"
        >
            <div class="h-full w-full max-w-xl bg-panel border-l border-line overflow-auto">
                <div class="p-6">
                    <div class="flex items-center justify-between">
                        <div class="font-semibold">{{ drawer.isNew ? '新建文件' : '编辑文件' }}</div>
                        <button class="btn-ghost !py-1" @click="drawer.open = false">关闭</button>
                    </div>

                    <div class="mt-4">
                        <label class="text-xs text-slate-500">分发文件名 <span class="text-rose-300">*</span></label>
                        <input v-model="drawer.form.name" class="input mt-1.5 font-mono" placeholder="rules.yaml" />
                        <div class="text-[11px] text-slate-600 mt-1">
                            决定分享链接的路径：<code>/share/file/&lt;分发文件名&gt;</code>
                        </div>
                        <div v-if="renaming" class="text-[11px] text-amber-300/90 mt-1.5 leading-relaxed">
                            ⚠ 改名会让已发出的分享链接 <code>/share/file/{{ drawer.originalName }}</code> 失效。
                        </div>
                    </div>

                    <div class="mt-3">
                        <label class="text-xs text-slate-500">显示名（可选）</label>
                        <input v-model="drawer.form.displayName" class="input mt-1.5" />
                    </div>

                    <div class="mt-3">
                        <label class="text-xs text-slate-500">来源</label>
                        <div class="flex gap-2 mt-1.5">
                            <button
                                class="btn-ghost !py-1.5 text-xs"
                                :class="drawer.form.source === 'local' ? '!border-accent/60 !text-accent2' : ''"
                                @click="drawer.form.source = 'local'"
                            >本地内容</button>
                            <button
                                class="btn-ghost !py-1.5 text-xs"
                                :class="drawer.form.source === 'remote' ? '!border-accent/60 !text-accent2' : ''"
                                @click="drawer.form.source = 'remote'"
                            >远程地址</button>
                        </div>
                    </div>

                    <div v-if="drawer.form.source === 'remote'" class="mt-3">
                        <label class="text-xs text-slate-500">地址</label>
                        <input v-model="drawer.form.url" class="input mt-1.5 font-mono !text-xs" placeholder="https://..." />
                    </div>
                    <div v-else class="mt-3">
                        <label class="text-xs text-slate-500">内容（≤ 512KB）</label>
                        <textarea
                            v-model="drawer.form.content"
                            class="input mt-1.5 font-mono !text-xs resize-y"
                            rows="14"
                            spellcheck="false"
                        ></textarea>
                        <div class="text-[11px] text-slate-600 mt-1">
                            {{ fmtSize((drawer.form.content || '').length) }} / 512 KB
                        </div>
                    </div>

                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn-ghost text-xs" @click="drawer.open = false">取消</button>
                        <button class="btn-primary text-xs" :disabled="drawer.saving" @click="saveFile">
                            {{ drawer.saving ? '保存中…' : '保存' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- 分享弹窗（与转换页成品卡共用） -->
        <ShareDialog
            v-model:open="share.open"
            :name="share.name"
            type="file"
            @created="onShareCreated"
        />
    </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, useDialog } from 'naive-ui';
import draggable from 'vuedraggable';
import { api } from '../stores/auth.js';
import EmptyState from '../components/EmptyState.vue';
import TgPushButton from '../components/TgPushButton.vue';
import ShareDialog from '../components/ShareDialog.vue';
import ShareList from '../components/ShareList.vue';
import { validateName } from '../utils/name.js';
import { downloadFile } from '../utils/download.js';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const files = ref([]);
const shares = ref([]);
const loading = ref(true);

// 当前展开分享面板的文件名。同一时刻只展开一张卡片，再点一次收起。
const panelFor = ref('');

const drawer = reactive({
    open: false,
    isNew: true,
    saving: false,
    originalName: '',
    form: { name: '', displayName: '', source: 'local', url: '', content: '' },
});

// 分享弹窗的开关与目标。有效期 / 请求体 / 成功后的时序都收在 ShareDialog 里。
const share = reactive({
    open: false,
    name: '',
});

const renaming = computed(() => !drawer.isNew && drawer.form.name !== drawer.originalName);

function extOf(name) {
    const base = String(name || '').split(/[?#]/)[0];
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot === base.length - 1) return '';
    const ext = base.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function fmtSize(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

async function load() {
    loading.value = true;
    try {
        const res = await api('/api/files');
        files.value = res.data || [];
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

async function loadShares() {
    try {
        const res = await api('/api/shares');
        shares.value = res.data || [];
    } catch {
        /* ignore */
    }
}

async function onDragEnd() {
    try {
        const res = await api('/api/sort/files', {
            method: 'POST',
            body: JSON.stringify(files.value.map((f) => f.name)),
        });
        files.value = res.data || files.value;
    } catch (e) {
        message.error(`排序保存失败：${e.message}`);
        load();
    }
}

async function onUpload(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    let okCount = 0;
    for (const f of list) {
        if (f.size > 512 * 1024) {
            message.error(`${f.name} 超过 512KB，已跳过`);
            continue;
        }
        try {
            const content = await f.text();
            const res = await api('/api/files', {
                method: 'POST',
                body: JSON.stringify({ name: f.name, source: 'local', content }),
            });
            files.value = res.data || files.value;
            okCount += 1;
        } catch (err) {
            message.error(`${f.name}：${err.message}`);
        }
    }
    if (okCount) message.success(`已上传 ${okCount} 个文件`);
    loadShares();
}

function openNew() {
    drawer.isNew = true;
    drawer.originalName = '';
    drawer.form = { name: '', displayName: '', source: 'local', url: '', content: '' };
    drawer.open = true;
}

function openEdit(f) {
    drawer.isNew = false;
    drawer.originalName = f.name;
    drawer.form = {
        name: f.name,
        displayName: f.displayName || '',
        source: f.source === 'remote' ? 'remote' : 'local',
        url: f.url || '',
        content: '',
    };
    drawer.open = true;
    // 列表接口不带正文，打开时才按需拉完整记录
    api(`/api/file/${encodeURIComponent(f.name)}`)
        .then((res) => {
            drawer.form.content = res.data?.content || '';
            drawer.form.url = res.data?.url || '';
        })
        .catch(() => {});
}

async function saveFile() {
    const name = String(drawer.form.name || '').trim();
    const nameErr = validateName(name, { label: '分发文件名' });
    if (nameErr) return message.error(nameErr);
    drawer.saving = true;
    try {
        if (drawer.isNew) {
            const res = await api('/api/files', { method: 'POST', body: JSON.stringify(drawer.form) });
            files.value = res.data || files.value;
            message.success('已创建');
        } else {
            const renamed = drawer.originalName !== name;
            const res = await api(`/api/file/${encodeURIComponent(drawer.originalName)}`, {
                method: 'PATCH',
                body: JSON.stringify(drawer.form),
            });
            files.value = res.data || files.value;
            // 后端会同步把分享码上的旧名改成新名，前端这两处缓存要跟着走
            if (renamed) {
                if (panelFor.value === drawer.originalName) panelFor.value = name;
                await loadShares();
            }
            message.success('已保存');
        }
        drawer.open = false;
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    } finally {
        drawer.saving = false;
    }
}

/** 下载文件正文（远程文件打开其地址，本地内容走 API 取正文） */
async function download(f) {
    try {
        await downloadFile(f);
    } catch (e) {
        message.error(`下载失败：${e.message}`);
    }
}

function remove(f) {
    dialog.warning({
        title: '删除文件',
        content: `确定删除「${f.displayName || f.name}」？相关分享链接会一并失效。`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: async () => {
            try {
                const res = await api(`/api/file/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
                files.value = res.data || [];
                // 卡片没了，展开状态要一起清掉，否则同名新文件会被意外展开
                if (panelFor.value === f.name) panelFor.value = '';
                loadShares();
                message.success('已删除');
            } catch (e) {
                message.error(e.message);
            }
        },
    });
}

// 某个文件当前持有的分享码（只算 type=file 且名称对得上的）
function sharesOf(name) {
    return shares.value.filter((s) => s.type === 'file' && s.name === name);
}

// 点卡片上的「分享链接」：就地展开/收起该卡片的链接列表
function togglePanel(f) {
    panelFor.value = panelFor.value === f.name ? '' : f.name;
}

// 点卡片上的「生成链接」：打开生成弹窗，成功后直接把面板展开给用户看
function openGen(f) {
    share.open = true;
    share.name = f.name;
}

/**
 * 弹窗生成成功后：先把列表拉回来，再展开面板 ——
 * 顺序反了的话展开时 sharesOf() 还是旧数据，会闪一下「还没有分享链接」。
 */
async function onShareCreated() {
    await loadShares();
    panelFor.value = share.name;
    message.success('已生成分享链接，可在卡片下方复制');
}

async function delShare(s) {
    try {
        const res = await api(`/api/shares?code=${encodeURIComponent(s.code)}`, { method: 'DELETE' });
        shares.value = res.data || [];
    } catch (e) {
        message.error(e.message);
    }
}

onMounted(() => {
    load();
    loadShares();
});
</script>
