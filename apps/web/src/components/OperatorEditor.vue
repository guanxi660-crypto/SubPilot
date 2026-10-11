<template>
    <div class="flex flex-col min-h-0" :class="{ 'h-full': fill }">
        <!-- 工具栏 -->
        <div class="flex flex-wrap items-center gap-2">
            <n-dropdown trigger="click" :options="addOptions" @select="addOp">
                <button class="btn-ghost !py-1.5 text-xs">+ 添加算子</button>
            </n-dropdown>
            <n-dropdown
                trigger="click"
                :options="templateOptions"
                @select="onTemplateSelect"
            >
                <button class="btn-ghost !py-1.5 text-xs">⚡ 套用模板</button>
            </n-dropdown>
            <button
                class="btn-ghost !py-1.5 text-xs"
                :disabled="!list.length"
                title="把当前算子链存成自定义模板，之后可一键套用，也能交给 AI 改"
                @click="openSaveAs"
            >☆ 存为模板</button>
            <button class="btn-ghost !py-1.5 text-xs" @click="addRaw">+ 自定义 JSON</button>
            <button class="btn-ghost !py-1.5 text-xs" @click="showHelp = !showHelp">
                {{ showHelp ? '收起填法速查' : '? 填法速查' }}
            </button>

            <div class="ml-auto flex gap-1 rounded-lg p-0.5 border border-line bg-panel/40">
                <button
                    v-for="m in MODES"
                    :key="m.key"
                    class="px-2.5 py-1 text-[11px] rounded-md transition"
                    :class="mode === m.key ? 'bg-accent/20 text-accent2' : 'text-slate-400 hover:text-slate-200'"
                    @click="mode = m.key"
                >
                    {{ m.label }}
                </button>
            </div>
        </div>

        <!-- 填法速查：一次把所有算子的用法和示例摊开，省得逐个添加再展开试 -->
        <div
            v-if="showHelp"
            class="mt-3 rounded-xl border border-line bg-panel2/40 p-4 max-h-80 overflow-auto"
        >
            <div class="text-xs font-semibold">算子填法速查</div>
            <div class="text-[11px] text-slate-600 mt-1">
                链按从上到下执行。常用组合：无效节点过滤 → 地区筛选 → 排序 → 国旗标识 → 数量截断。
            </div>
            <div class="mt-3 space-y-3">
                <div v-for="t in operatorTypes" :key="t.type">
                    <div class="text-xs font-medium">{{ t.icon }} {{ t.label }}</div>
                    <div class="text-[11px] text-slate-500 mt-1 leading-relaxed">{{ usageOf(t.type) }}</div>
                </div>
            </div>
        </div>

        <!-- 卡片模式。fill 下由 flex-1 吃掉父容器剩余高度、内部自己滚，
             而不是把父卡片顶高 —— 父卡片的高度是被左侧「实时预览」定的。 -->
        <div
            v-if="mode === 'card'"
            class="mt-3 space-y-2"
            data-op-list
            :class="fill ? 'flex-1 min-h-0 overflow-auto pr-1' : ''"
        >
            <div v-if="!list.length" class="text-xs text-slate-600 py-4 text-center border border-dashed border-line rounded-xl">
                还没有算子。点「添加算子」挑一个 —— 例如「无效节点过滤 → 地区筛选 → 排序」。
                <div class="mt-1 text-[11px] text-slate-500">
                    加完点右侧的「参数」按钮展开，里面有每个参数的填法和示例。
                </div>
            </div>

            <div
                v-for="(op, i) in list"
                :key="i"
                class="card !rounded-xl p-3 transition"
                :class="op.disabled ? 'opacity-50' : ''"
            >
                <div class="flex items-center gap-2">
                    <span class="text-[11px] text-slate-600 font-mono w-5 shrink-0">{{ i + 1 }}</span>
                    <input
                        type="checkbox"
                        class="accent-accent shrink-0"
                        :checked="!op.disabled"
                        title="启用 / 禁用"
                        @change="toggleOp(i, $event.target.checked)"
                    />
                    <span class="text-sm shrink-0">{{ metaOf(op.type).icon }}</span>
                    <span class="text-sm font-medium truncate">{{ labelOf(op) }}</span>
                    <span
                        class="text-[11px] text-slate-600 truncate hidden sm:inline"
                        :title="descOf(op)"
                    >{{ descOf(op) }}</span>
                    <div class="ml-auto flex items-center gap-1.5 shrink-0">
                        <!-- ↑↓ 用 slate-400 而非 500：深色/玻璃主题下 500 太暗，
                             挨着强调色胶囊会显得像禁用态（亮色主题有专门覆盖，仍是 #475569） -->
                        <button class="icon-btn text-slate-400" title="上移" :disabled="i === 0" @click="move(i, -1)">↑</button>
                        <button class="icon-btn text-slate-400" title="下移" :disabled="i === list.length - 1" @click="move(i, 1)">↓</button>
                        <!-- 展开 / 收起原先是个 24px 的裸 ▸ 图标：点不准（触屏尤甚），
                             slate-500 在深色卡片上又几乎看不出是个按钮。改成带文字的
                             accent 胶囊 —— 高度对齐左右两侧的图标按钮，颜色跟随主题变量。 -->
                        <button
                            class="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border leading-none
                                   text-[11px] font-medium text-accent2 transition-colors"
                            :class="expanded === i
                                ? 'bg-accent/35 border-accent/80'
                                : 'bg-accent/20 border-accent/50 hover:bg-accent/30 hover:border-accent/70'"
                            :title="expanded === i ? '收起参数' : '展开参数'"
                            :aria-expanded="expanded === i"
                            @click="expanded = expanded === i ? -1 : i"
                        >
                            <!-- 三角形字形本身留白多，跟正文同号会显得很小，单独放大加粗 -->
                            <span class="text-[13px] font-bold leading-none">{{ expanded === i ? '▾' : '▸' }}</span>
                            <span>{{ expanded === i ? '收起' : '参数' }}</span>
                        </button>
                        <button class="icon-btn !text-rose-300/80" title="删除" @click="removeOp(i)">✕</button>
                    </div>
                </div>

                <!-- 说明与参数编辑器合成一块：上面「怎么填」、下面「填什么」，
                     中间只用一条分隔线，不做成两个独立卡片 —— 它们是同一件事的两半。
                     （原先还挂了个「示例参数」，内容就是 args 的默认值本身，写了等于没写，已删。） -->
                <div v-if="expanded === i" class="mt-3 rounded-xl border border-line overflow-hidden">
                    <!-- 自定义名称：填了就顶掉卡片上显示的算子名。存进算子的 name 字段，
                         不动 type —— 后端按 type 查处理函数，改 type 这一步就不生效了。
                         留空则回落成算子本名。 -->
                    <div class="px-3 py-2 bg-panel2/50 border-b border-line flex items-center gap-2">
                        <span class="text-[11px] text-slate-400 shrink-0">自定义名称</span>
                        <input
                            :value="op.name || ''"
                            class="input !py-1 !text-xs flex-1 min-w-0"
                            :maxlength="OP_NAME_MAX"
                            :placeholder="`留空则显示「${metaOf(op.type).label}」`"
                            @input="setName(i, $event.target.value)"
                        />
                    </div>
                    <div class="px-3 py-2.5 bg-panel2/50 border-b border-line text-[11px] text-slate-400 leading-relaxed">
                        {{ usageOf(op.type) }}
                    </div>
                    <div class="p-3">
                        <JsonEditor
                            :model-value="opJson(i)"
                            label="参数 args（JSON）"
                            :rows="6"
                            validate="json"
                            @update:model-value="(v) => setArgs(i, v)"
                        />
                    </div>
                </div>
                <div v-else class="mt-2 text-[11px] text-slate-600 font-mono truncate">
                    {{ compactArgs(op) }}
                </div>
            </div>
        </div>

        <!-- JSON 源码模式：编辑器是固定行高的 textarea，fill 下只让它自己滚 -->
        <div v-else class="mt-3" :class="fill ? 'flex-1 min-h-0 overflow-auto' : ''">
            <JsonEditor
                :model-value="source"
                label="算子链源码（JSON 数组）"
                :rows="16"
                validate="json"
                placeholder='[{ "type": "Useless Filter", "args": {} }]'
                @update:model-value="onSource"
            />
            <div class="text-[11px] text-slate-600 mt-1.5">
                源码模式下改的是整条链，失焦即同步到卡片视图。JSON 非法时不会覆盖已生效的内容。
            </div>
        </div>

        <!-- ================= 存为自定义模板 ================= -->
        <!-- 用自绘遮罩而不是 naive 的 NModal：全站弹窗风格都是这套 Tailwind 卡片，
             混进一个 naive 弹窗会在玻璃/亮色主题下露出不同的圆角和阴影。
             z-[60] 高于「模板管理」的 z-50 —— 它可以从管理面板里被唤起，
             同层的话会因为 DOM 顺序被压在下面，看起来像"点了没反应"。
             ⚠️ 必须 Teleport 到 body：本组件嵌在 .card（backdrop-blur）里，
             backdrop-filter 会把 fixed 后代的包含块劫持成那张卡片 ——
             弹窗就"被限制"在编辑器里出不来了。 -->
        <Teleport to="body">
        <div
            v-if="saveAs.open"
            class="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 p-6 overflow-auto"
            @click.self="saveAs.open = false"
        >
            <div class="card w-full max-w-lg mt-16 p-5">
                <div class="text-sm font-semibold">存为自定义模板</div>
                <div class="text-[11px] text-slate-500 mt-1 leading-relaxed">
                    把当前 {{ list.length }} 个算子存成模板。之后可以在「⚡ 套用模板」里一键套用，
                    也能交给 AI 助手继续修改。
                </div>
                <div class="mt-4 space-y-3">
                    <label class="block">
                        <span class="text-xs text-slate-400">模板名称</span>
                        <input
                            v-model="saveAs.name"
                            class="input mt-1 !py-1.5 text-sm"
                            maxlength="40"
                            placeholder="例如：只要港台日新美 + 加国旗"
                        />
                    </label>
                    <label class="block">
                        <span class="text-xs text-slate-400">说明（可选）</span>
                        <input
                            v-model="saveAs.desc"
                            class="input mt-1 !py-1.5 text-sm"
                            maxlength="200"
                            placeholder="一句话说清它做什么，会显示在下拉菜单里"
                        />
                    </label>
                </div>
                <div class="flex justify-end gap-2 mt-5">
                    <button class="btn-ghost !py-1.5 text-xs" @click="saveAs.open = false">取消</button>
                    <button
                        class="btn-primary !py-1.5 text-xs"
                        :disabled="saveAs.saving || !saveAs.name.trim()"
                        @click="confirmSaveAs"
                    >{{ saveAs.saving ? '保存中…' : '保存模板' }}</button>
                </div>
            </div>
        </div>
        </Teleport>

        <!-- ================= 模板管理（大工作台） ================= -->
        <!-- 以前是个 max-w-3xl 的小弹窗、编辑还要再开一层 —— 算子链 JSON 一行能拖很长，
             小框里改起来要不停滚动。现在直接开一个大工作台：左侧列表、右侧整块编辑区，
             选中即编辑，不再套第二层弹窗。
             ⚠️ 必须 Teleport 到 body：backdrop-blur 的祖先卡片会把 fixed 后代困在卡片里
             （实测弹窗只有 691×495，正是「被限制了」的根因）。 -->
        <Teleport to="body">
        <div
            v-if="manager.open"
            class="fixed inset-0 z-50 flex items-stretch justify-center bg-black/55 p-3 sm:p-6"
            @click.self="closeManager"
        >
            <div class="card w-full max-w-[1500px] h-full max-h-[92vh] p-5 flex flex-col">
                <div class="flex items-start gap-3 shrink-0">
                    <div>
                        <div class="text-sm font-semibold">模板管理</div>
                        <div class="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                            自定义模板存在服务端，换设备也在；左侧选中后直接在右侧编辑，改完保存即时生效。
                        </div>
                    </div>
                    <button class="btn-ghost !py-1.5 text-xs ml-auto shrink-0" @click="closeManager">关闭</button>
                </div>

                <div class="flex-1 min-h-0 mt-4 grid gap-4 lg:grid-cols-[300px_1fr]">
                    <!-- 左：模板列表 -->
                    <div class="min-h-0 overflow-auto pr-1 space-y-4">
                        <!-- 内置：只读，改不了（代码常量），但可以套用 -->
                        <div>
                            <div class="text-xs font-medium text-slate-400">内置模板（只读）</div>
                            <div class="mt-2 space-y-1.5">
                                <button
                                    v-for="p in processPresets"
                                    :key="p.name"
                                    class="w-full text-left rounded-xl border px-3 py-2 transition"
                                    :class="manager.selKind === 'builtin' && manager.selName === p.name
                                        ? 'border-accent/60 bg-accent/15'
                                        : 'border-line bg-panel2/40 hover:border-accent/40'"
                                    @click="selectBuiltin(p)"
                                >
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs font-medium truncate">{{ p.name }}</span>
                                        <span class="text-[11px] text-slate-500 ml-auto shrink-0">{{ p.process.length }} 个算子</span>
                                    </div>
                                    <div class="text-[11px] text-slate-500 mt-0.5">{{ p.desc }}</div>
                                </button>
                            </div>
                        </div>

                        <!-- 自定义：可选中编辑 / 套用 / 交给 AI / 删除 -->
                        <div>
                            <div class="flex items-center gap-2">
                                <div class="text-xs font-medium text-slate-400">自定义模板（{{ customTemplates.length }}）</div>
                                <button
                                    class="btn-ghost !py-1 !px-2 !text-[11px] ml-auto"
                                    :disabled="!list.length"
                                    :title="list.length ? '用编辑器里当前的算子链新建一个模板' : '编辑器里还没有算子'"
                                    @click="startNew"
                                >＋ 新建</button>
                            </div>
                            <div
                                v-if="!customTemplates.length"
                                class="mt-2 rounded-xl border border-dashed border-line px-3 py-6 text-center text-[11px] text-slate-500"
                            >
                                还没有自定义模板。在编辑器里调好算子链，点工具栏的「☆ 存为模板」就能存下来。
                            </div>
                            <div v-else class="mt-2 space-y-1.5">
                                <button
                                    v-for="t in customTemplates"
                                    :key="t.name"
                                    class="w-full text-left rounded-xl border px-3 py-2 transition"
                                    :class="manager.selKind === 'custom' && manager.selName === t.name
                                        ? 'border-accent/60 bg-accent/15'
                                        : 'border-line bg-panel2/40 hover:border-accent/40'"
                                    @click="selectCustom(t)"
                                >
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs font-medium truncate">{{ t.name }}</span>
                                        <span class="text-[11px] text-slate-500 ml-auto shrink-0">{{ t.process.length }} 个算子</span>
                                    </div>
                                    <div v-if="t.desc" class="text-[11px] text-slate-500 mt-0.5">{{ t.desc }}</div>
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- 右：编辑区（大） -->
                    <div class="min-h-0 flex flex-col rounded-xl border border-line bg-panel2/20 p-3">
                        <template v-if="manager.selKind">
                            <div class="shrink-0 flex items-center gap-2 flex-wrap">
                                <div class="text-xs font-semibold">
                                    {{ manager.selKind === 'new'
                                        ? '新建模板'
                                        : manager.selKind === 'builtin'
                                            ? `内置模板「${manager.selName}」`
                                            : `编辑模板「${manager.selName}」` }}
                                </div>
                                <span
                                    v-if="manager.selKind === 'builtin'"
                                    class="text-[10px] px-2 py-0.5 rounded-full border border-line text-slate-400"
                                >只读 · 可套用</span>
                                <div class="ml-auto flex gap-1.5">
                                    <button class="btn-ghost !py-1 text-[11px]" @click="applySelected">套用</button>
                                    <button
                                        v-if="manager.selKind === 'custom'"
                                        class="btn-ghost !py-1 text-[11px]"
                                        title="跳到 AI 助手，让它帮你改这个模板"
                                        @click="editWithAiSelected"
                                    >AI 编辑</button>
                                    <button
                                        v-if="manager.selKind === 'custom'"
                                        class="btn-ghost !py-1 text-[11px] !text-rose-300/80"
                                        @click="askDeleteSelected"
                                    >删除</button>
                                </div>
                            </div>

                            <div class="shrink-0 grid sm:grid-cols-2 gap-3 mt-3">
                                <label class="block">
                                    <span class="text-[11px] text-slate-400">名称（1–40 字符，不能与内置模板重名）</span>
                                    <input
                                        v-model="manager.draft.name"
                                        class="input mt-1 !py-1.5 text-sm"
                                        maxlength="40"
                                        :disabled="manager.selKind === 'builtin'"
                                    />
                                </label>
                                <label class="block">
                                    <span class="text-[11px] text-slate-400">说明（可选，会显示在套用菜单里）</span>
                                    <input
                                        v-model="manager.draft.desc"
                                        class="input mt-1 !py-1.5 text-sm"
                                        maxlength="200"
                                        :disabled="manager.selKind === 'builtin'"
                                    />
                                </label>
                            </div>

                            <JsonEditor
                                fill
                                class="flex-1 min-h-0 mt-3"
                                :model-value="manager.draft.processText"
                                label="算子链（JSON 数组）"
                                validate="json"
                                :readonly="manager.selKind === 'builtin'"
                                @update:model-value="(v) => (manager.draft.processText = v)"
                            />

                            <div v-if="manager.selKind !== 'builtin'" class="shrink-0 flex justify-end gap-2 mt-3">
                                <button
                                    class="btn-primary !py-1.5 text-xs"
                                    :disabled="manager.saving || !manager.draft.name.trim()"
                                    @click="saveDraft"
                                >{{ manager.saving ? '保存中…' : manager.selKind === 'new' ? '保存模板' : '保存修改' }}</button>
                            </div>
                        </template>

                        <div v-else class="flex-1 flex items-center justify-center text-[11px] text-slate-500">
                            从左侧选一个模板开始编辑，或点「＋ 新建」。
                        </div>
                    </div>
                </div>
            </div>
        </div>
        </Teleport>
    </div>
</template>

<script setup>
import { computed, reactive, ref, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { NDropdown, useMessage, useDialog } from 'naive-ui';
import JsonEditor from './JsonEditor.vue';
import {
    operatorTypes,
    processPresets,
    customTemplates,
    loadOperatorMeta,
    createTemplate,
    updateTemplate,
    removeTemplate,
    metaOf,
    nextCustomName,
    OP_NAME_MAX,
} from '../stores/operators.js';

const props = defineProps({
    modelValue: { type: Array, default: () => [] },
    /**
     * 撑满父容器。订阅编辑页用它把这一列的底边和左侧「实时预览」对齐 ——
     * 开启后卡片列表 / 源码框改为 flex-1 + 内部滚动，而不是把父卡片顶高。
     */
    fill: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const MODES = [
    { key: 'card', label: '卡片' },
    { key: 'source', label: 'JSON' },
];
const mode = ref('card');
const expanded = ref(-1);
const showHelp = ref(false);
const source = ref('');
const sourceValid = ref(true);

const list = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

// ---- 存为模板 ----
const saveAs = reactive({ open: false, name: '', desc: '', saving: false });

// ---- 模板管理（大工作台）----
// 选中即编辑：selKind = 'builtin'（只读）/ 'custom'（改现有）/ 'new'（新建）。
const manager = reactive({
    open: false,
    selKind: '',
    selName: '',
    saving: false,
    draft: { name: '', desc: '', processText: '[]' },
});

onMounted(async () => {
    await loadOperatorMeta();
    source.value = JSON.stringify(list.value, null, 2);
});

// 卡片改动 → 同步源码
watch(
    () => props.modelValue,
    (v) => {
        if (mode.value === 'card') source.value = JSON.stringify(v || [], null, 2);
    },
    { deep: true },
);

function push(next) {
    emit('update:modelValue', next);
}

// ---- 增删改 ----

const addOptions = computed(() =>
    (operatorTypes.value.length ? operatorTypes.value : []).map((t) => ({
        label: `${t.icon}  ${t.label}  —  ${t.desc}`,
        key: t.type,
    })),
);

function addOp(type) {
    const t = operatorTypes.value.find((x) => x.type === type);
    const args = t?.args ? JSON.parse(JSON.stringify(t.args)) : {};
    push([...list.value, { type, args }]);
    expanded.value = list.value.length;
}

/**
 * 「+ 自定义 JSON」：加一个占位算子，用户自己往 args 里填内容。
 *
 * 默认名不再是内置算子的「无效节点过滤」，而是「自定义1」——
 * 它本来就不是那个算子，顶着人家的名字只会让人以为点错了。
 * 名字存在独立的 name 字段（不改 type：后端按 type 查处理函数，
 * 改了 type 这一步就直接被跳过，等于白加）。
 */
function addRaw() {
    push([...list.value, { type: 'Useless Filter', args: {}, name: nextCustomName(list.value) }]);
    expanded.value = list.value.length;
}

/** 改自定义名称。清空则删掉 name 字段，卡片回落到算子本名。 */
function setName(i, v) {
    const name = String(v ?? '').slice(0, OP_NAME_MAX);
    push(
        list.value.map((o, k) => {
            if (k !== i) return o;
            const copy = { ...o };
            if (name) copy.name = name;
            else delete copy.name;
            return copy;
        }),
    );
}

/** 卡片标题：有自定义名称就用它，否则用算子本名 */
function labelOf(op) {
    return String(op?.name ?? '').trim() || metaOf(op.type).label;
}

/**
 * 卡片副标题：起了自定义名称时回落成**算子本名** ——
 * 「自定义3」本身看不出这一步到底做什么，旁边补一句本名才不至于变成黑盒。
 */
function descOf(op) {
    const meta = metaOf(op.type);
    return String(op?.name ?? '').trim() ? meta.label : meta.desc;
}

/**
 * 套用模板 —— 注意是**整条覆盖**，不是追加。
 * 链上已经有算子时先问一句：以前是直接覆盖，用户以为「先套清理、再套排序」能叠加，
 * 实际第二次把第一次的结果冲掉了（这也是内置模板从 4 条合并成 1 条的直接原因）。
 */
function applyTemplateProcess(process, label) {
    const doApply = () => {
        push(JSON.parse(JSON.stringify(process)));
        mode.value = 'card';
        expanded.value = -1;
        message.success(`已套用「${label}」`);
    };
    if (!list.value.length) return doApply();
    dialog.warning({
        title: '覆盖当前算子链？',
        content: `套用模板会替换掉现在这 ${list.value.length} 个算子（不是追加）。`,
        positiveText: '覆盖',
        negativeText: '取消',
        onPositiveClick: doApply,
    });
}

/** 下拉里选中：模板项套用，「管理」项开面板 */
function onTemplateSelect(key) {
    if (key === '__manage') {
        openManager();
        return;
    }
    const [kind, ...rest] = String(key).split(':');
    const name = rest.join(':');
    const pool = kind === 'custom' ? customTemplates.value : processPresets.value;
    const p = pool.find((x) => x.name === name);
    if (p) applyTemplateProcess(p.process, p.name);
}

// ---- 存为模板 ----

function openSaveAs() {
    if (!list.value.length) return;
    saveAs.name = '';
    saveAs.desc = '';
    saveAs.open = true;
}

async function confirmSaveAs() {
    const name = saveAs.name.trim();
    if (!name) return;
    saveAs.saving = true;
    try {
        await createTemplate({
            name,
            desc: saveAs.desc.trim(),
            process: JSON.parse(JSON.stringify(list.value)),
        });
        saveAs.open = false;
        message.success(`模板「${name}」已保存`);
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    } finally {
        saveAs.saving = false;
    }
}

// ---- 模板管理（大工作台）----

function openManager() {
    manager.open = true;
    if (customTemplates.value.length) selectCustom(customTemplates.value[0]);
    else if (processPresets.value.length) selectBuiltin(processPresets.value[0]);
    else manager.selKind = '';
}

function closeManager() {
    manager.open = false;
}

function selectBuiltin(p) {
    manager.selKind = 'builtin';
    manager.selName = p.name;
    manager.draft.name = p.name;
    manager.draft.desc = p.desc || '';
    manager.draft.processText = JSON.stringify(p.process || [], null, 2);
}

function selectCustom(t) {
    manager.selKind = 'custom';
    manager.selName = t.name;
    manager.draft.name = t.name;
    manager.draft.desc = t.desc || '';
    manager.draft.processText = JSON.stringify(t.process || [], null, 2);
}

/** 新建：以编辑器里当前的算子链为初值，右侧直接进入编辑态 */
function startNew() {
    if (!list.value.length) return;
    manager.selKind = 'new';
    manager.selName = '';
    manager.draft.name = '';
    manager.draft.desc = '';
    manager.draft.processText = JSON.stringify(list.value, null, 2);
}

async function saveDraft() {
    let process;
    try {
        process = JSON.parse(manager.draft.processText);
    } catch {
        return message.error('算子链 JSON 解析失败，检查一下括号和引号');
    }
    if (!Array.isArray(process) || !process.length) {
        return message.error('算子链必须是非空数组');
    }
    const name = manager.draft.name.trim();
    if (!name) return message.error('模板名称不能为空');
    manager.saving = true;
    try {
        if (manager.selKind === 'new') {
            await createTemplate({ name, desc: manager.draft.desc.trim(), process });
            message.success(`模板「${name}」已保存`);
        } else {
            await updateTemplate(manager.selName, { name, desc: manager.draft.desc.trim(), process });
            message.success('模板已更新');
        }
        manager.selKind = 'custom';
        manager.selName = name;
    } catch (e) {
        message.error(e.message, { duration: 8000 });
    } finally {
        manager.saving = false;
    }
}

/** 套用右侧当前选中的模板（内置或自定义），整条覆盖当前算子链 */
function applySelected() {
    const pool = manager.selKind === 'builtin' ? processPresets.value : customTemplates.value;
    const p = pool.find((x) => x.name === manager.selName);
    if (p) applyTemplateProcess(p.process, p.name);
}

function askDeleteSelected() {
    const name = manager.selName;
    if (!name) return;
    dialog.warning({
        title: '删除模板',
        content: `确定删除自定义模板「${name}」？此操作不可撤销。`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: async () => {
            try {
                await removeTemplate(name);
                message.success('已删除');
                if (customTemplates.value.length) selectCustom(customTemplates.value[0]);
                else manager.selKind = '';
            } catch (e) {
                message.error(e.message, { duration: 8000 });
            }
        },
    });
}

/** 交给 AI：跳到 AI 助手并把该模板设为对话目标（AIAssistant 读 query.template） */
function editWithAiSelected() {
    const name = manager.selName;
    closeManager();
    router.push({ path: '/ai', query: { template: name } });
}

function removeOp(i) {
    const next = [...list.value];
    next.splice(i, 1);
    push(next);
    expanded.value = -1;
}

function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= list.value.length) return;
    const next = [...list.value];
    [next[i], next[j]] = [next[j], next[i]];
    push(next);
    expanded.value = j;
}

function toggleOp(i, enabled) {
    const next = list.value.map((o, k) => (k === i ? { ...o, disabled: !enabled } : o));
    push(next);
}

function opJson(i) {
    return JSON.stringify(list.value[i]?.args ?? {}, null, 2);
}

function setArgs(i, text) {
    try {
        const args = JSON.parse(text);
        const next = list.value.map((o, k) => (k === i ? { ...o, args } : o));
        push(next);
    } catch {
        /* JsonEditor 已经提示了，这里不覆盖，避免把非法内容写进链 */
    }
}

function compactArgs(op) {
    try {
        return JSON.stringify(op.args ?? {});
    } catch {
        return '{}';
    }
}

/** 使用说明：后端给了 usage 就用它，否则回落到一行 desc（兜底表里没有 usage） */
function usageOf(type) {
    const t = metaOf(type);
    return t?.usage || t?.desc || '';
}

function onSource(v) {
    source.value = v;
    try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) {
            sourceValid.value = true;
            push(parsed);
        } else {
            sourceValid.value = false;
        }
    } catch {
        sourceValid.value = false;
    }
}

/**
 * 下拉选项：内置模板 + 自定义模板分组，末尾挂「管理」入口。
 * 用 key 前缀区分来源 —— 同名虽然后端拦住了，但前缀让这里的查找不必再猜是哪个池子。
 */
const templateOptions = computed(() => {
    const opts = [];
    if (processPresets.value.length) {
        opts.push({
            type: 'group',
            label: '内置模板',
            key: 'g-builtin',
            children: processPresets.value.map((p) => ({
                label: `${p.name} — ${p.desc}`,
                key: `builtin:${p.name}`,
            })),
        });
    }
    if (customTemplates.value.length) {
        opts.push({
            type: 'group',
            label: '自定义模板',
            key: 'g-custom',
            children: customTemplates.value.map((p) => ({
                label: `${p.name}${p.desc ? ` — ${p.desc}` : ''}`,
                key: `custom:${p.name}`,
            })),
        });
    }
    if (opts.length) opts.push({ type: 'divider', key: 'd1' });
    opts.push({ label: '⚙ 管理模板…', key: '__manage' });
    return opts;
});
</script>

<style scoped>
/* 用纯 CSS 而不是 @apply：scoped 样式块里的 @apply 依赖 postcss 链路，
   这里只有几行，直接写死更省事也更稳。 */
/* 行内图标按钮（上移 / 下移 / 删除）。
   1.5rem → 1.75rem：24px 的点击区偏小，且与右侧「参数」胶囊不等高，
   视觉上会让胶囊显得突兀。字号同步 +1px。
   颜色**不在这里写**，由模板上的 text-slate-500 负责 —— 亮色主题对
   .text-slate-500 有专门的压深覆盖（styles.css），写死在组件里会绕过它。 */
.icon-btn {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8125rem;
    transition: color 0.15s ease, background-color 0.15s ease;
}
.icon-btn:hover:not(:disabled) {
    color: var(--accent2);
    background: rgb(var(--c-panel2));
}
.icon-btn:disabled {
    opacity: 0.25;
    pointer-events: none;
}
</style>
