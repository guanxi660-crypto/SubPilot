<template>
    <div class="h-full flex">
        <!-- 左侧：实时预览（和订阅编辑页的实时预览同一套：节点列表 + 算子日志）。
             默认打开、可收起 —— 与右侧「历史」对称。
             预览对象自动切换：有未处理的 AI 提案时预览提案，否则预览当前草稿。 -->
        <aside
            v-if="openPreview"
            class="w-80 shrink-0 border-r border-line bg-panel/40 overflow-auto p-5 hidden lg:block"
        >
            <div class="flex items-center gap-2">
                <div class="text-sm font-semibold">实时预览</div>
                <span v-if="preview.loading" class="text-xs text-slate-500">解析中…</span>
                <span v-else-if="preview.total !== null" class="text-xs text-slate-500">
                    {{ preview.total }} 个节点
                </span>
                <span v-if="preview.format" class="type-badge type-default">{{ preview.format }}</span>
                <button class="btn-ghost !py-1 text-xs ml-auto" @click="runPreview" title="重新预览">↻</button>
                <button class="btn-ghost !py-1 text-xs" @click="openPreview = false" title="收起">«</button>
            </div>
            <div class="text-[11px] mt-1" :class="pendingProposal ? 'text-emerald-300/80' : 'text-slate-600'">
                {{ pendingProposal ? '正在预览最新 AI 提案（未落库）' : '预览当前草稿算子链' }}
            </div>
            <div v-if="preview.error" class="text-xs text-rose-300/80 mt-3">{{ preview.error }}</div>
            <div
                v-if="preview.log?.length"
                class="mt-3 bg-panel2 rounded-xl p-3 text-[11px] font-mono text-slate-500 space-y-0.5 max-h-32 overflow-auto"
            >
                <div v-for="(l, i) in preview.log" :key="i">{{ l }}</div>
            </div>
            <div class="mt-3 max-h-[calc(100vh-200px)] overflow-auto">
                <NodeList :nodes="preview.nodes" />
            </div>
        </aside>

        <!-- 主区 -->
        <div class="flex-1 flex flex-col min-w-0">
            <!-- 顶栏 -->
            <div class="px-6 py-4 border-b border-line flex items-center gap-3 flex-wrap">
                <div>
                    <h1 class="text-lg font-bold">AI 助手</h1>
                    <p class="text-[11px] text-slate-500 mt-0.5">
                        让它帮你写 JSON 脚本：筛选、排序、重命名
                    </p>
                </div>
                <select v-model="sourceKey" class="input !w-auto !py-1.5 text-xs ml-auto" @change="onSourceChange">
                    <option value="">— 选择订阅 / 组合 / 模板 —</option>
                    <optgroup v-if="subs.length" label="订阅">
                        <option v-for="s in subs" :key="'s' + s.name" :value="'sub:' + s.name">
                            {{ s.displayName || s.name }}
                        </option>
                    </optgroup>
                    <optgroup v-if="collections.length" label="组合">
                        <option v-for="c in collections" :key="'c' + c.name" :value="'col:' + c.name">
                            {{ c.displayName || c.name }}
                        </option>
                    </optgroup>
                    <!-- 模板是「不绑定订阅」的算子链：让助手改模板，等于产出可复用的脚本，
                         改完存回模板即可，不必先挑一个订阅当靶子。 -->
                    <optgroup v-if="customTemplates.length" label="自定义模板">
                        <option v-for="t in customTemplates" :key="'t' + t.name" :value="'tpl:' + t.name">
                            {{ t.name }}
                        </option>
                    </optgroup>
                </select>
                <button class="btn-ghost !py-1.5 text-xs" @click="newSession">＋ 新会话</button>
                <button class="btn-ghost !py-1.5 text-xs" @click="openPreview = !openPreview">
                    {{ openPreview ? '收起预览' : '预览' }}
                </button>
                <button class="btn-ghost !py-1.5 text-xs" @click="openHistory = !openHistory">
                    {{ openHistory ? '收起历史' : '历史' }}
                </button>
            </div>

            <!-- 消息 -->
            <div ref="scrollEl" class="flex-1 overflow-auto px-6 py-5">
                <div v-if="!sourceKey" class="max-w-xl mx-auto">
                    <EmptyState
                        icon="✦"
                        title="先选一个订阅、组合或模板"
                        hint="助手会读取它的节点样例，帮你生成合适的 JSON 脚本"
                    />
                </div>

                <div v-else-if="!messages.length" class="max-w-2xl mx-auto">
                    <EmptyState
                        icon="✦"
                        title="开始对话"
                        hint="例如：把剩余流量和官网这类假节点删掉，按地区排序，并给节点加上国旗"
                    />
                    <div class="flex flex-wrap gap-2 justify-center mt-2">
                        <button
                            v-for="q in QUICK"
                            :key="q"
                            class="btn-ghost !py-1.5 text-xs"
                            @click="send(q)"
                        >{{ q }}</button>
                    </div>
                </div>

                <div v-else class="max-w-3xl mx-auto space-y-4">
                    <div v-for="(m, i) in messages" :key="i" class="flex gap-3" :class="m.role === 'user' ? 'justify-end' : ''">
                        <div
                            class="rounded-2xl px-4 py-2.5 text-sm max-w-[85%] whitespace-pre-wrap break-words"
                            :class="m.role === 'user'
                                ? 'bg-accent/20 border border-accent/30'
                                : 'bg-panel2 border border-line'"
                        >
                            <!-- 助手回复里的 json 代码块由下面的提案卡片承载，正文里剥掉，
                                 否则同一份 JSON 会以「```json …」的原始 markdown 再糊一遍。 -->
                            <div v-if="m.role === 'user'">{{ m.content }}</div>
                            <div v-else>{{ assistantText(m) || (m.streaming || m.proposal ? '' : '（空）') }}</div>
                            <span v-if="m.streaming" class="inline-flex ml-1">
                                <i class="typing-dot"></i><i class="typing-dot"></i><i class="typing-dot"></i>
                            </span>
                            <span v-else-if="m.stopped" class="text-[11px] text-slate-500 ml-1">（已中断）</span>

                            <div v-if="m.proposal" class="mt-3 border-t border-line pt-3">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-[11px] text-emerald-300/90">
                                        助手给出了 {{ m.proposal.length }} 个算子的提案
                                    </span>
                                    <!-- 「忽略」「保存」都是一次性的：点完整组消失，
                                         换成一行结果文字 —— 免得手抖连点把同一条链覆盖两遍。
                                         「预览」不再放这里：左侧常驻实时预览面板会自动跟着
                                         最新提案刷新，效果一出来就能看到。 -->
                                    <div v-if="!m.resolved" class="flex gap-2 ml-auto">
                                        <button
                                            class="btn-ghost !py-1 text-xs"
                                            :disabled="m.saving"
                                            @click="ignoreProposal(m)"
                                        >忽略</button>
                                        <button
                                            class="btn-primary !py-1 text-xs"
                                            :disabled="m.saving"
                                            @click="saveProposal(m)"
                                        >{{ m.saving ? '保存中…' : '保存' }}</button>
                                    </div>
                                    <span
                                        v-else
                                        class="ml-auto text-[11px]"
                                        :class="m.resolved === 'saved' ? 'text-emerald-300/90' : 'text-slate-500'"
                                    >{{ m.resolved === 'saved' ? `已保存到「${m.savedTo}」` : '已忽略' }}</span>
                                </div>

                                <div v-if="!m.resolved" class="text-[11px] text-slate-600 mt-2 leading-relaxed">
                                    「保存」会用它<strong>整体覆盖</strong>「{{ currentSourceName }}」当前的算子链
                                    （不是追加）。左侧预览已经按这条提案跑好了，看完再决定。
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-if="error" class="text-xs text-rose-300/80 flex items-center gap-2 flex-wrap">
                        <span>{{ error }}</span>
                        <button class="btn-ghost !py-0.5 !px-2 !text-[11px]" @click="retry">↻ 重试</button>
                    </div>

                    <!-- 追问入口：聊到一半想换个方向时不用重新打字 -->
                    <div v-if="!streaming" class="flex flex-wrap gap-2 justify-center pt-1">
                        <button
                            v-for="q in QUICK"
                            :key="'f' + q"
                            class="btn-ghost !py-1 !px-2.5 !text-[11px] opacity-60 hover:opacity-100"
                            @click="send(q)"
                        >{{ q }}</button>
                    </div>
                </div>
            </div>

            <!-- 输入 -->
            <div class="border-t border-line px-6 py-4">
                <div class="max-w-3xl mx-auto flex gap-2 items-end">
                    <textarea
                        v-model="input"
                        class="input !text-sm resize-none"
                        rows="2"
                        :disabled="!sourceKey || streaming"
                        :placeholder="sourceKey ? '说说你想怎么整理这些节点…（Enter 发送，Shift+Enter 换行）' : '先在上面选一个订阅、组合或模板'"
                        @keydown.enter.exact.prevent="send()"
                    ></textarea>
                    <!-- 流式期间「发送」换成「停止」：中止的是整条链路 ——
                         浏览器断开 SSE，服务端把上游模型请求一起 abort，
                         不会出现「界面停了但后台还在烧 token」。 -->
                    <button
                        v-if="streaming"
                        class="btn-ghost shrink-0 !border-rose-400/40 !text-rose-300"
                        title="中断本次回答"
                        @click="stop"
                    >停止</button>
                    <button
                        v-else
                        class="btn-primary shrink-0"
                        :disabled="!sourceKey || !input.trim()"
                        @click="send()"
                    >发送</button>
                </div>
                <div class="max-w-3xl mx-auto text-[11px] text-slate-600 mt-2 leading-relaxed">
                    助手只拿到<strong>前 60 个节点</strong>当样例（用来认命名规律和地区），
                    看不到完整节点列表；它不能执行代码、也不能测速。
                    提案不会自动落库 —— 左侧预览看效果，再决定「保存」还是「忽略」。
                </div>
            </div>
        </div>

        <!-- 草稿 / 历史 侧栏 -->
        <aside
            v-if="openHistory"
            class="w-80 shrink-0 border-l border-line bg-panel/40 overflow-auto p-5 hidden lg:block"
        >
            <div class="text-sm font-semibold">当前草稿</div>
            <div v-if="!draft.length" class="text-[11px] text-slate-600 mt-2">还没有算子。让助手生成，或手动添加。</div>
            <div v-else class="mt-3 space-y-1.5">
                <div
                    v-for="(op, i) in draft"
                    :key="i"
                    class="text-[11px] font-mono bg-panel2 rounded-lg px-2.5 py-1.5 truncate"
                    :title="JSON.stringify(op)"
                >{{ i + 1 }}. {{ op.type }}</div>
            </div>
            <div class="flex flex-wrap gap-2 mt-3">
                <button class="btn-ghost !py-1 text-xs" :disabled="!draft.length" @click="clearDraft">清空</button>
                <button class="btn-primary !py-1 text-xs" :disabled="!draft.length" @click="saveDraft">
                    {{ isTemplate ? '存回模板' : '保存到来源' }}
                </button>
                <!-- 草稿存成新模板：AI 产出的链常常值得留着复用，
                     但直接覆盖某个订阅又太粗暴，这条出口刚好。 -->
                <button
                    class="btn-ghost !py-1 text-xs"
                    :disabled="!draft.length"
                    title="把草稿存成一个新的自定义模板"
                    @click="tplAs.open = !tplAs.open"
                >存为模板</button>
            </div>
            <div v-if="tplAs.open" class="flex gap-2 mt-2">
                <input
                    v-model="tplAs.name"
                    class="input !py-1 text-xs"
                    maxlength="40"
                    placeholder="给模板起个名字"
                    @keydown.enter="confirmDraftAsTemplate"
                />
                <button
                    class="btn-primary !py-1 text-xs shrink-0"
                    :disabled="tplAs.saving || !tplAs.name.trim()"
                    @click="confirmDraftAsTemplate"
                >{{ tplAs.saving ? '…' : '保存' }}</button>
            </div>
            <div class="text-[11px] text-slate-600 mt-2 leading-relaxed">
                当前目标：{{ currentSourceName }}<span v-if="isTemplate">（自定义模板）</span>
            </div>

            <div class="mt-6 flex items-center gap-2">
                <div class="text-sm font-semibold">会话历史</div>
                <span v-if="sessions.length" class="text-[10px] text-slate-600">{{ sessions.length }} 条</span>
            </div>
            <div v-if="!sessions.length" class="text-[11px] text-slate-600 mt-2">暂无历史会话</div>
            <div v-else class="mt-3 space-y-1.5">
                <!-- 历史跨来源汇总：换订阅之后还能翻回上一份的对话，
                     所以每条都要标清「哪个来源 + 聊的什么 + 什么时候」。
                     点一条会连带把上方来源切过去。 -->
                <div
                    v-for="s in sessions"
                    :key="s.id"
                    class="flex items-start gap-2 text-xs rounded-lg px-2.5 py-2 cursor-pointer transition"
                    :class="s.id === sessionId ? 'bg-accent/15 border border-accent/30' : 'bg-panel2 border border-transparent hover:border-line'"
                    @click="loadSession(s.id)"
                >
                    <div class="min-w-0 flex-1">
                        <div class="text-[10px] text-accent/80 truncate" :title="sourceNameOf(s.sourceKey)">
                            {{ sourceNameOf(s.sourceKey) }}
                        </div>
                        <div class="truncate mt-0.5">{{ s.title || '新会话' }}</div>
                        <div class="text-[10px] text-slate-600 mt-0.5">{{ fmtTime(s.updatedAt) }}</div>
                    </div>
                    <button class="shrink-0 text-slate-600 hover:text-rose-300" @click.stop="delSession(s.id)">✕</button>
                </div>
            </div>
        </aside>
    </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { api } from '../stores/auth.js';
import {
    customTemplates,
    loadOperatorMeta,
    createTemplate,
    updateTemplate,
} from '../stores/operators.js';
import EmptyState from '../components/EmptyState.vue';
import NodeList from '../components/NodeList.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const QUICK = [
    '删掉剩余流量、官网这类假节点，按地区排序',
    '只保留港台日新美，并加上国旗',
    '把所有节点重名去掉，名称统一成「地区 编号」',
    '把节点按协议类型分组排序',
];

const subs = ref([]);
const collections = ref([]);
const sourceKey = ref('');
const messages = ref([]);
const input = ref('');
const streaming = ref(false);
const error = ref('');
const scrollEl = ref(null);
const draft = ref([]);
// 左右两个侧栏都默认打开：左=实时预览（与订阅编辑页同款），右=草稿/历史
const openPreview = ref(true);
const openHistory = ref(true);
const sessions = ref([]);
const sessionId = ref('');

/** 侧栏「存为模板」的内联输入 */
const tplAs = reactive({ open: false, name: '', saving: false });

/** 实时预览（结构与订阅编辑页的 preview 完全一致） */
const preview = reactive({ loading: false, error: '', nodes: [], log: [], total: null, format: '' });

/**
 * 最新一条「未处理」的提案：有它时左侧预览自动切到提案效果，
 * 忽略 / 保存之后自动回落到草稿预览。
 */
const pendingProposal = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
        const m = messages.value[i];
        if (m.role === 'assistant' && m.proposal && !m.resolved) return m;
    }
    return null;
});

// ---- 预览（700ms 防抖，与订阅编辑页同款节奏）----
let previewTimer = null;
function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 700);
}

/**
 * 跑左侧实时预览。预览对象自动二选一：
 *   · 有未处理的 AI 提案 → 用提案的算子链（让用户先看效果再决定保不保存）
 *   · 否则 → 当前草稿
 * 目标来源与保存逻辑一致：订阅/组合用自身，模板借第一个订阅当靶子。
 */
async function runPreview() {
    const cur = currentSource();
    if (!cur) {
        preview.error = '先在上方选择一个订阅、组合或模板';
        preview.nodes = [];
        preview.log = [];
        preview.total = null;
        preview.format = '';
        return;
    }
    const isTpl = sourceKey.value.startsWith('tpl:');
    const probe = isTpl ? subs.value[0] : cur;
    if (!probe) {
        preview.error = isTpl ? '站内还没有订阅，无法预览模板效果' : '来源数据为空';
        preview.nodes = [];
        preview.log = [];
        preview.total = 0;
        preview.format = '';
        return;
    }
    const isCol = !isTpl && sourceKey.value.startsWith('col:');
    const chain = pendingProposal.value?.proposal ?? draft.value;
    preview.loading = true;
    preview.error = '';
    try {
        const res = await api(isCol ? '/api/preview/collection' : '/api/preview/sub', {
            method: 'POST',
            body: JSON.stringify(
                isCol
                    ? { subscriptions: probe.subscriptions, process: chain }
                    : { ...probe, process: chain },
            ),
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

// 来源、草稿、提案任何一处变化都自动重跑预览；面板收起时不跑（省请求）
watch(
    [sourceKey, draft, () => pendingProposal.value?.proposal, () => pendingProposal.value?.resolved, openPreview],
    () => {
        if (openPreview.value) schedulePreview();
    },
);

/** 当前目标是不是自定义模板 */
const isTemplate = computed(() => sourceKey.value.startsWith('tpl:'));

// 会话按来源分桶存（`sp_sessions:<来源 key>`）—— 保存路径简单、不会互相覆盖。
// 但「历史」列表要跨桶汇总：换到别的订阅之后还能翻回上一份的对话。
const SESSION_PREFIX = 'sp_sessions:';
const LAST_KEY = 'sp_chat_last';

function bucketKey(key = sourceKey.value) {
    return `${SESSION_PREFIX}${key}`;
}

function readBucket(key = sourceKey.value) {
    try {
        const v = JSON.parse(localStorage.getItem(bucketKey(key)) || '[]');
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

function writeBucket(list, key = sourceKey.value) {
    localStorage.setItem(bucketKey(key), JSON.stringify(list));
}

/** 全部会话（跨来源），按最近使用排前面 */
function allSessions() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(SESSION_PREFIX)) continue;
        const src = k.slice(SESSION_PREFIX.length);
        for (const s of readBucket(src)) {
            if (s && s.id) out.push({ ...s, sourceKey: src });
        }
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function findSession(id) {
    return allSessions().find((x) => x.id === id) || null;
}

function refreshSessions() {
    sessions.value = allSessions();
}

/** 会话记录里的来源 key → 人看的名字（订阅显示名优先） */
function sourceNameOf(key) {
    if (!key) return '未指定来源';
    const name = key.slice(4);
    if (key.startsWith('sub:')) {
        const s = subs.value.find((x) => x.name === name);
        return s ? s.displayName || s.name : name;
    }
    if (key.startsWith('col:')) {
        const c = collections.value.find((x) => x.name === name);
        return c ? c.displayName || c.name : name;
    }
    if (key.startsWith('tpl:')) return `${name}（模板）`;
    return key;
}

/** 历史里的时间：当天只给时分，跨年补上年份 */
function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
    if (d.getFullYear() !== now.getFullYear()) {
        return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function newSession() {
    sessionId.value = '';
    messages.value = [];
    error.value = '';
}

function loadSession(id) {
    const s = findSession(id);
    if (!s) return;
    sessionId.value = id;
    messages.value = JSON.parse(JSON.stringify(s.messages || []));
    draft.value = JSON.parse(JSON.stringify(s.draft || []));
    error.value = '';
    // 跨来源的历史：直接切过去。这里改 sourceKey 不触发下拉的 @change，
    // 所以不会被 onSourceChange 覆盖成「该来源最近一条会话」。
    if (s.sourceKey && s.sourceKey !== sourceKey.value) {
        sourceKey.value = s.sourceKey;
        localStorage.setItem(LAST_KEY, s.sourceKey);
    }
    scrollBottom();
}

function delSession(id) {
    const s = findSession(id);
    if (!s) return;
    const rest = readBucket(s.sourceKey).filter((x) => x.id !== id);
    if (rest.length) writeBucket(rest, s.sourceKey);
    else localStorage.removeItem(bucketKey(s.sourceKey));
    if (sessionId.value === id) newSession();
    refreshSessions();
}

/** 把当前会话写回 localStorage（标题取首条 user 消息前 24 字） */
function persist() {
    if (!sourceKey.value) return;
    if (!messages.value.length && !draft.value.length) return;
    const list = readBucket();
    const title =
        messages.value.find((m) => m.role === 'user')?.content?.slice(0, 24) || '新会话';
    if (!sessionId.value) sessionId.value = `s${Date.now().toString(36)}`;
    const idx = list.findIndex((x) => x.id === sessionId.value);
    const record = { id: sessionId.value, title, messages: messages.value, draft: draft.value, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = record;
    else list.unshift(record);
    writeBucket(list);
    localStorage.setItem(LAST_KEY, sourceKey.value);
    refreshSessions();
}

function onSourceChange() {
    localStorage.setItem(LAST_KEY, sourceKey.value);
    // 该来源下最近一条会话优先；没有就开新会话，草稿取来源当前的算子链
    const mine = readBucket().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (mine.length) {
        loadSession(mine[0].id);
    } else {
        newSession();
        const cur = currentSource();
        draft.value = JSON.parse(JSON.stringify(cur?.process || []));
    }
}

function currentSource() {
    if (sourceKey.value.startsWith('sub:')) {
        return subs.value.find((s) => s.name === sourceKey.value.slice(4));
    }
    if (sourceKey.value.startsWith('col:')) {
        return collections.value.find((c) => c.name === sourceKey.value.slice(3));
    }
    if (sourceKey.value.startsWith('tpl:')) {
        return customTemplates.value.find((t) => t.name === sourceKey.value.slice(4));
    }
    return null;
}

async function scrollBottom() {
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
}

/**
 * 助手回复的正文：把 ```json 代码块剥掉。
 * 提案已经有专门卡片展示，正文里再糊一遍原始 markdown 只是噪音。
 * 流式期间代码块还没闭合，所以第二条正则把「未闭合的尾部」也一并去掉。
 */
function assistantText(m) {
    let t = String(m.content || '');
    t = t.replace(/```[\s\S]*?```/g, '');
    t = t.replace(/```[\s\S]*$/, '');
    return t.trim();
}

/** 本次请求的中止开关（非响应式，只是给「停止」按钮留个把手） */
let abortCtrl = null;
/** 本次流在服务端的 id：用于显式通知服务端掐上游 */
let streamId = '';

/**
 * 中断本次回答。两条腿一起走：
 *   1. 断开 SSE —— 线上的 runtime 会因此取消流并把上游请求 abort
 *   2. 带 streamId 打一次 /ai/assistant/abort —— 不依赖 runtime 的断连语义
 *      （本地 dev 代理就不会把断连传进 isolate），保证「停止」真的省下 token
 */
function stop() {
    if (!abortCtrl) return;
    const id = streamId;
    if (id) {
        fetch('/ai/assistant/abort', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(localStorage.getItem('sp_token')
                    ? { Authorization: `Bearer ${localStorage.getItem('sp_token')}` }
                    : {}),
            },
            body: JSON.stringify({ id }),
        }).catch(() => {
            /* 通知失败不影响界面上的中断 */
        });
    }
    abortCtrl.abort();
}

/** 失败后重试：把结尾那条没产出的助手消息去掉，用同一个问题再问一次 */
function retry() {
    if (streaming.value) return;
    let lastUser = '';
    for (let i = messages.value.length - 1; i >= 0; i--) {
        if (messages.value[i].role === 'user') {
            lastUser = messages.value[i].content;
            break;
        }
    }
    if (!lastUser) return;
    while (messages.value.length && messages.value[messages.value.length - 1].role === 'assistant') {
        messages.value.pop();
    }
    messages.value.pop();
    error.value = '';
    send(lastUser);
}

async function send(preset) {
    const text = String(preset || input.value).trim();
    if (!text || streaming.value || !sourceKey.value) return;
    input.value = '';
    error.value = '';
    messages.value.push({ role: 'user', content: text });
    const assistant = { role: 'assistant', content: '', streaming: true, proposal: null };
    messages.value.push(assistant);
    scrollBottom();

    streaming.value = true;
    abortCtrl = new AbortController();
    // 服务端会先回一个 meta 事件把 streamId 告诉客户端；本地先备一个，
    // 万一 meta 没到（旧后端），stop() 就只走「断开 SSE」那条腿。
    streamId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
        const ctx = await loadContext();
        const res = await fetch('/ai/assistant/stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(localStorage.getItem('sp_token')
                    ? { Authorization: `Bearer ${localStorage.getItem('sp_token')}` }
                    : {}),
            },
            signal: abortCtrl.signal,
            body: JSON.stringify({
                messages: messages.value
                    .filter((m) => !m.streaming)
                    .map((m) => ({ role: m.role, content: m.content })),
                samples: ctx.samples,
                total: ctx.total,
                // 告诉助手当前在改什么：模板要写得通用，订阅要贴着这份节点来
                task: isTemplate.value ? 'template' : 'source',
                // 草稿链 + 目标名。没有这两项，助手只能从聊天记录里猜用户改到哪一步，
                // 「再加一条 / 把刚才的排序去掉」这类增量请求必然答不准。
                process: draft.value,
                target: currentSourceName.value,
                id: streamId,
            }),
        });

        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
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
                if (evt.type === 'meta') {
                    if (evt.id) streamId = evt.id;
                } else if (evt.type === 'delta') {
                    assistant.content += evt.delta;
                    scrollBottom();
                } else if (evt.type === 'proposal') {
                    // 提案一到位，左侧实时预览就会自动切到提案效果（watch pendingProposal）
                    assistant.proposal = evt.process;
                    // 模型编造的算子已在服务端剔掉，这里如实告诉用户
                    if (evt.dropped?.length) {
                        message.warning(`已忽略助手编造的算子：${evt.dropped.join('、')}`, { duration: 8000 });
                    }
                } else if (evt.type === 'error') {
                    error.value = evt.message;
                }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') assistant.stopped = true;
        else error.value = `对话失败：${e.message}`;
    } finally {
        abortCtrl = null;
        streamId = '';
        assistant.streaming = false;
        streaming.value = false;
        persist();
        scrollBottom();
    }
}

/** 拉取节点样例给助手做上下文（最多 60 个，带总数） */
async function loadContext() {
    const cur = currentSource();
    if (!cur) return { samples: [], total: 0 };
    try {
        // 模板不绑定订阅，自己没有任何节点。借站内第一个订阅的节点当样例 ——
        // 助手总得看见真实节点长什么样，否则它写的正则是凭空想象的。
        // 借不到就老实给空，不编。
        const isTpl = sourceKey.value.startsWith('tpl:');
        const probe = isTpl ? subs.value[0] : cur;
        if (!probe) return { samples: [], total: 0 };

        const isCol = !isTpl && sourceKey.value.startsWith('col:');
        const body = isCol
            ? { subscriptions: probe.subscriptions, process: [] }
            : { ...probe, process: [] };
        const res = await api(isCol ? '/api/preview/collection' : '/api/preview/sub', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const list = res.data?.processed || [];
        return { samples: list.slice(0, 60), total: res.data?.total ?? list.length };
    } catch {
        return { samples: [], total: 0 };
    }
}

/** 当前来源的名字，用于「保存会覆盖 xxx」这类提示 —— 让用户知道动的是哪一份 */
const currentSourceName = computed(() => {
    const cur = currentSource();
    return cur ? cur.displayName || cur.name : '当前来源';
});

/**
 * 把提案落到当前目标上。
 * 早先是「应用到草稿」→ 再去侧栏点「保存到订阅」两步，中间那步很容易忘，
 * 结果就是助手说改了、订阅其实没变。这里一步到位。
 * 目标有三种：订阅 / 组合（PATCH 各自接口）、自定义模板（PATCH 模板接口）。
 */
async function saveProposal(m) {
    const cur = currentSource();
    if (!cur) return message.error('请先在上方选择一个订阅、组合或模板');
    const next = JSON.parse(JSON.stringify(m.proposal || []));
    m.saving = true;
    try {
        await writeProcess(cur, next);
        // 草稿跟着更新，否则侧栏还挂着旧链，看着像没保存成功
        draft.value = next;
        m.resolved = 'saved';
        m.savedTo = cur.displayName || cur.name;
        persist();
        message.success(`已保存 ${next.length} 个算子到「${m.savedTo}」`);
        await load();
    } catch (e) {
        // 失败不置 resolved —— 按钮留着，改完配置还能再点一次
        message.error(e.message, { duration: 8000 });
    } finally {
        m.saving = false;
    }
}

/** 把一条算子链写回「当前目标」，三种目标各自的落库方式收敛在这里 */
async function writeProcess(cur, process) {
    if (sourceKey.value.startsWith('tpl:')) {
        await updateTemplate(cur.name, { process });
        return;
    }
    const isSub = sourceKey.value.startsWith('sub:');
    await api(
        isSub
            ? `/api/sub/${encodeURIComponent(cur.name)}`
            : `/api/collection/${encodeURIComponent(cur.name)}`,
        { method: 'PATCH', body: JSON.stringify({ process }) },
    );
}

function ignoreProposal(m) {
    m.resolved = 'ignored';
    persist();
}

function clearDraft() {
    draft.value = [];
    persist();
}

async function saveDraft() {
    const cur = currentSource();
    if (!cur) return;
    try {
        await writeProcess(cur, draft.value);
        message.success(isTemplate.value ? '已存回模板' : '已保存到来源');
        await load();
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    }
}

/** 把当前草稿存成一个**新的**自定义模板 */
async function confirmDraftAsTemplate() {
    const name = tplAs.name.trim();
    if (!name) return;
    tplAs.saving = true;
    try {
        await createTemplate({
            name,
            desc: '',
            process: JSON.parse(JSON.stringify(draft.value)),
        });
        tplAs.open = false;
        tplAs.name = '';
        message.success(`已存为模板「${name}」，可在编辑器的「套用模板」里找到`);
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    } finally {
        tplAs.saving = false;
    }
}

async function load() {
    try {
        const [s, c] = await Promise.all([api('/api/subs'), api('/api/collections')]);
        subs.value = s.data || [];
        collections.value = c.data || [];
        // 模板列表也要有：来源下拉里要列出它们，否则「AI 编辑模板」进不来
        await loadOperatorMeta();
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }
}

/** 从「模板管理 → AI 编辑」跳进来时，直接选中那个模板 */
function applyRouteTemplate() {
    const t = String(route.query.template || '');
    if (!t) return false;
    if (!customTemplates.value.some((x) => x.name === t)) return false;
    const key = `tpl:${t}`;
    if (sourceKey.value === key) return true;
    sourceKey.value = key;
    onSourceChange();
    return true;
}

// 历史列表跨来源汇总，所以来源变化只是换个高亮，不改变「列出哪些」
watch(sourceKey, () => refreshSessions());

// 已经在 AI 助手页时，从别处再跳过来（query 变了但组件没重建）也要跟着切
watch(
    () => route.query.template,
    () => applyRouteTemplate(),
);

onMounted(async () => {
    await load();
    // 历史是全局的：即使还没选来源也要列出来（选中态靠 sessionId 标）
    refreshSessions();
    // 优先响应「AI 编辑某模板」的跳转，其次才是上次的会话目标
    if (applyRouteTemplate()) {
        schedulePreview();
        return;
    }
    const last = localStorage.getItem(LAST_KEY);
    if (
        last &&
        (subs.value.some((s) => `sub:${s.name}` === last) ||
            collections.value.some((c) => `col:${c.name}` === last) ||
            customTemplates.value.some((t) => `tpl:${t.name}` === last))
    ) {
        sourceKey.value = last;
        onSourceChange();
    }
    // 首次进页面把预览跑起来
    schedulePreview();
});
</script>
