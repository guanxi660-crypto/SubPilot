<template>
    <!-- 整页锁定一屏：min-h-full + flex-col，网格 flex-1 吃掉剩余高度。
         「编辑订阅」是个表单页，默认打开就该整页可见 —— 之前页面比视口高 149px，
         两列底部各有 84px 落在折叠线以下，被底部悬浮条盖住，得滚一下才看得到。

         底部留白必须写成响应式变体（md:pb-20），不能裸写 pb-20：
         Tailwind 把 md: 变体生成在基础工具类**之后**，所以 md:p-10 的
         padding-bottom（2.5rem = 40px）会盖掉裸写 pb-20 的 5rem。
         悬浮保存条高 63px，80px 留白给它 17px 余量；移动端悬浮条抬到
         bottom-16（离底 64px，占 64..127），所以小屏留 144px（pb-36）。

         min-h-full（而不是 h-full）：窗口太矮、内容确实放不下时，
         容器还能被内容撑高，页面照常滚动 —— 只是不再有「够高却要滚」的情况。 -->
    <div class="p-6 md:p-10 max-w-7xl mx-auto pb-36 md:pb-20 min-h-full flex flex-col">
        <div class="flex items-center gap-3 shrink-0">
            <button class="btn-ghost !py-1.5 text-xs" @click="back">‹ 返回</button>
            <h1 class="text-2xl font-bold">
                {{ isNew ? '新建订阅' : '编辑订阅' }}
                <span v-if="renamed" class="text-xs text-amber-300/90 ml-2">· 已改名</span>
            </h1>
        </div>

        <div v-if="loading" class="card p-8 mt-6 text-sm text-slate-500">加载中…</div>

        <template v-else>
            <!-- 左 1 右 2：左边实时预览，右边基本信息 + 脚本处理上下堆叠。
                 flex-1：网格吃掉标题以下的全部高度，不再按内容自然高度走。
                 lg:grid-rows-[minmax(0,1fr)]：**关键**。隐式 auto 行的高度 = 内容的
                 max-content —— CodeMirror 几千字节的节点内容会把行撑到 2000px+，
                 min-h-0 切不断（那只是允许收缩，行高照样按内容算）。
                 显式把行定成 minmax(0,1fr) 后行高才真正等于网格高度，
                 编辑器才肯缩到一屏内。lg 以下堆叠布局保持自然行高。
                 min-h-[680px]：窗口的下限。再矮就不硬塞了 —— 页面照常滚动，
                 但卡片内部不会被压扁溢出（基本信息最小 436 + JSON 最小 190 + 间距 16）。
                 grow basis-0：**必须是定长 basis**。flex-basis: 0%（flex-1 的写法）在
                 容器高度不定（这里是 min-h-full）时会按规范退化为 content，
                 CodeMirror 的内容高度就把整页撑到 2000px+，一切自适应全作废；
                 0px 是定长，不参与百分比解析，才真的从 0 开始分。
                 items-stretch（而非 items-start）：两列拉成等高，右列的底边
                 （JSON 脚本处理）才能和左列（实时预览）对齐 —— 此前 items-start
                 下两列各按内容高度走，预览卡片底边 443、JSON 卡片底边 1117，
                 差了近 700px，页面右下角像是被啃掉一块。
                 预览卡片因此要 flex-col，让节点列表 flex-1 吃掉多出来的高度，
                 列表超出时自己滚（不再把卡片撑高）。 -->
            <div
                class="grid lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)] gap-4 mt-6 items-stretch grow basis-0 min-h-[680px]"
                :class="jsonFlexNone ? 'mb-16' : ''"
                :style="gridMinH != null ? { minHeight: `${gridMinH}px` } : undefined"
            >
                <!-- 预览：默认 stretch 到底边对齐；JSON 拉伸时 self-start，
                     自身保持内容自然高（不被右列拉高），顶对齐网格顶，
                     放弃底边对齐限制（页面随 JSON 向下拉伸） -->
                <div
                    class="card p-6 fade-up lg:col-span-1 flex flex-col min-h-0 relative"
                    :class="jsonFlexNone ? 'lg:self-start' : 'lg:self-stretch'"
                >
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

                    <!-- 节点列表：flex-1 随卡片伸缩、内部滚动。
                         不设手动拖动入口 —— 拖「节点内容」编辑器时预览列
                         跟着网格一起顶高，无需重复的调整入口 -->
                    <div class="mt-4 flex-1 min-h-0 flex flex-col relative">
                        <div data-preview-list class="overflow-auto grow min-h-0">
                            <NodeList :nodes="preview.nodes" />
                        </div>
                    </div>
                </div>

                <!-- 基本信息 + 脚本处理。
                     min-h-0：切断 CodeMirror 内容高度顺着 min-content 往上撑的链条
                     （见网格注释）。两张卡都 basis:0 + flex-grow，高度由 flex 算出来
                     才是「确定高度」，OperatorEditor 的 fill（h-full + 内部
                     overflow-auto）才滚得起来。3:1 的分法是按内容定的：
                     节点内容编辑器吃大头，JSON 卡片保持它原本约 190px 的观感。 -->
                <div class="lg:col-span-2 flex flex-col gap-4 min-h-0">
                    <!-- 基本信息：默认 flex-[3] 与 JSON 卡按 3:1 分高度；
                         手动拉伸节点内容后改为 flex-none（高度=内容）：
                         向上拖编辑器缩小时 JSON 卡吃剩余，向下拖时网格被顶高、
                         JSON 卡高度不变整体下移，两种情况底边都保持对齐。 -->
                    <div
                        class="card p-5 fade-up min-h-0 flex flex-col"
                        :class="contentEdH == null ? 'flex-[3]' : 'lg:flex-none'"
                        style="--d:100ms"
                    >
                        <div class="text-sm font-semibold mb-3 shrink-0">基本信息</div>
                        <div class="grid md:grid-cols-2 gap-3 shrink-0">
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

                        <div class="mt-3 shrink-0">
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

                        <div v-if="form.source === 'remote'" class="mt-3 flex-1 min-h-0 flex flex-col">
                            <label class="text-xs text-slate-500 shrink-0">订阅地址（一行一个，可填多个）</label>
                            <NodeContentEditor
                                v-model="form.url"
                                class="mt-1.5 h-40 resize-y lg:flex-1 lg:min-h-[120px] lg:resize-none"
                                placeholder="https://example.com/api/v1/client/subscribe?token=xxx"
                            />
                            <label class="text-xs text-slate-500 block mt-3 shrink-0">下载 UA（可选）</label>
                            <input v-model="form.ua" class="input mt-1.5 font-mono !text-xs shrink-0" placeholder="例如 clash-verge/v2.0" />
                        </div>

                        <!-- 节点内容是这一页的主要输入物：几十上百行 URI / YAML 是常态。
                             高度默认交给布局（lg:flex-1 随窗口伸缩，整页锁定一屏、
                             两列底边对齐）。右下角拉伸手柄常驻，跟老版 resize 一样
                             自由拉伸：编辑器变高多少，网格就顶高多少，JSON 卡高度
                             不变、整体下移，底边仍对齐，页面变长可滚；向上拖编辑器
                             自己缩小（下限 140），JSON 卡吃掉多出的空间。
                             「↺ 自适应」一键还原。

                             ⚠️ 为什么不用原生 resize-y：高度由 flex 决定时
                             （flex-basis:0），拖拽写进去的 inline height 会被直接
                             无视 —— 把手看得见却拖不动，比没有更糟。所以这里
                             自绘手柄、用 JS 把拖动换算成显式高度。
                             小屏（lg 以下）页面本来就是堆叠滚动，保留原生 resize-y
                             与固定 h-96（384px，约 15 行）。 -->
                        <div
                            v-else
                            ref="contentEdWrap"
                            class="mt-3 flex-1 min-h-0 flex flex-col relative"
                            :class="contentEdH == null ? '' : 'lg:flex-none'"
                        >
                            <!-- h-6 固定行高：按钮常驻（切换态高度变化不顶行），拖动换算不差像素 -->
                            <div class="flex items-center shrink-0 h-6">
                                <label class="text-xs text-slate-500">节点内容（URI 列表或 Clash YAML）</label>
                                <button
                                    class="btn-ghost !py-0.5 !px-1.5 text-[12px] leading-none ml-auto"
                                    :title="edExpanded ? '收起：恢复自适应高度' : '拉伸：完整展开内容'"
                                    @click="toggleEdExpand"
                                >{{ edExpanded ? '⤡' : '⤢' }}</button>
                                <button
                                    v-if="contentEdH != null"
                                    class="btn-ghost !py-0.5 !px-1.5 text-[10px]"
                                    title="恢复跟随窗口的自适应高度"
                                    @click="resetEdHeight"
                                >↺</button>
                            </div>
                            <NodeContentEditor
                                v-model="form.content"
                                class="mt-1.5 h-96"
                                :class="contentEdH == null ? 'lg:flex-1 lg:min-h-[140px]' : 'lg:flex-none'"
                                :style="contentEdH != null ? { height: `${contentEdH}px` } : undefined"
                                placeholder="ss://... 或&#10;proxies:&#10;  - name: xxx"
                            />
                            <!-- 拉伸热区：整个底边可拖（hover 显示高亮线提示） -->
                            <div
                                data-ed-grip
                                class="group absolute bottom-0 left-0 right-0 h-2 z-10 cursor-ns-resize"
                                title="拖动调整高度"
                                @mousedown.prevent="startEdResize"
                            >
                                <span class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-transparent group-hover:bg-sky-400/70 transition-colors"></span>
                            </div>
                        </div>
                    </div>

                    <!-- 脚本处理：flex-1 与基本信息按 1:3 分高度，底边即与左侧预览卡片对齐。
                         min-h-[240px]：OperatorEditor 固定部分（头部按钮行 + 卡片
                         padding）实测要 159px，空态算子列表还要 70px —— 190px 的
                         旧下限会让列表只剩 38px、连空态都内滚。
                         算子加多、内容需求超过一屏份额时 jsonFlexNone 切
                         lg:flex-none（高度=内容），配合 gridMinH 顶高网格 ——
                         3:1 的 flex 比例不知道内容需求，会把顶高的空间全塞给
                         信息卡、JSON 卡永远只有 1/4 继续内滚，所以必须在这里切。 -->
                    <div
                        class="card p-5 fade-up flex-1 min-h-[240px] flex flex-col"
                        :class="jsonFlexNone ? 'lg:flex-none' : ''"
                        style="--d:150ms"
                    >
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
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
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

// ---- 网格高度管理（编辑页核心布局）----
//
// 三股需求都汇到 gridMinH（computed，取各项最大值）：
//   1. 拖动节点内容编辑器手柄（edDragMinH）—— 编辑器长多少网格顶高多少；
//   2. JSON 卡自适应（autoMinH）—— 脚本算子越加越多时，JSON 卡内容
//      超过一屏分配的高度，网格自动顶高、页面变长滚动（用户点名需求：
//      默认尺寸不变，但算子多时允许超过整屏）。删算子后需求下降、
//      自动缩回（底线仍是一屏基线 680px）。
// 默认态两者都无干预 → 整页锁定一屏、两列底边对齐。
const contentEdH = ref(null);
const edDragMinH = ref(null);
const autoMinH = ref(null);
// JSON 卡内容需求超过一屏份额时切 flex-none（高度=内容），见 recomputeAuto
const jsonFlexNone = ref(false);
// 一屏基线：首次拖动时记下网格当时的（一屏）高度。之后每次拖动都
// 以它为基准换算网格最小高度 —— 不能用「当前网格高度」当基准，
// 否则向上拖回时 max() 会卡在上一次顶高的高度上回不来。
const gridBaseH = ref(null);
// 一屏基线：首次 recomputeAuto（网格未被顶高时）记录网格实际高度。
// over 判定用「need > 基线」而非写死 682 —— 视口高度不同（860/1200）时
// 一屏可用空间不同，写死阈值会误触发拉伸态（1200 视口 686 需求根本
// 装得下，却因 > 682 被判超屏，mb-16/self-start 全部误启动）。
const oneScreenH = ref(null);
const contentEdWrap = ref(null);
// ⤢ 拉伸切换：false = 自适应（800 上限），true = 内容完整展开
const edExpanded = ref(false);

const EDITOR_MIN = 140;
const EDITOR_MAX = 3000;
const JSON_GAP = 16; // 右列两张卡的 gap-4

/** 两股需求的合成值；都不干预时不输出 style */
const gridMinH = computed(() => {
    const vals = [edDragMinH.value, autoMinH.value].filter((v) => v != null);
    return vals.length ? Math.max(...vals) : null;
});

/** 通用拖拽装配：mousedown 起点算一次，move 回调里做算术 */
function beginDrag(e, onMove) {
    const move = (ev) => onMove(ev);
    const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none'; // 拖动时别把编辑器里的文本一起选中
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function startEdResize(e) {
    const wrap = contentEdWrap.value;
    const ed = wrap?.querySelector('.code-editor');
    if (!ed) return;
    // 起点全部量一次，拖动过程中只做算术（布局在变，不能边拖边量）
    const edH0 = ed.getBoundingClientRect().height;
    // info 卡内编辑器以外的固定部分（标题 + 表单 + label + padding）
    const infoCard = wrap.closest('.card');
    const infoChrome = infoCard ? infoCard.offsetHeight - edH0 : 0;
    // JSON 卡当前高度（flex-[1] 时可能高于 240 下限，按实际值算）
    const jsonCard = [...document.querySelectorAll('main .card')].find((c) =>
        (c.innerText || '').trimStart().startsWith('JSON 脚本处理')
    );
    const jsonH0 = jsonCard ? Math.round(jsonCard.offsetHeight) : 240;
    const startY = e.clientY;

    beginDrag(e, (ev) => {
        const h = Math.round(Math.min(EDITOR_MAX, Math.max(EDITOR_MIN, edH0 + ev.clientY - startY)));
        contentEdH.value = h;
        // info 卡切 flex-none 后，右列总需求 = infoChrome + h + gap + jsonNow。
        // 必须按这个顶网格 —— 不能用 flex 压缩后的一屏基线（682）做加法：
        // 右列固有需求比压缩基线高几像素，差额会让 JSON 卡溢出 row 底部、
        // 两列底边错位。不低于一屏（680+2）保证向上缩时网格回得去。
        edDragMinH.value = Math.round(Math.max(682, infoChrome + h + JSON_GAP + jsonH0));
    });
}

/**
 * JSON 卡自适应测量（绝对式，可收缩）：
 *   网格需求 = 信息卡需求 + gap + JSON 卡需求，需求 ≤ 一屏（680）时输出
 *   null 不干预 —— 默认态/算子很少时锁定一屏，算子加多、需求超过一屏
 *   后网格被顶高、页面变长；删算子后需求回落、自动缩回。
 * 两张卡的需求都用「chrome + 内容需求」计：
 *   · chrome = 卡片里除滚动区外的固定部分（offsetHeight - 编辑器/列表高），
 *     与 flex 拉伸无关，是常数；
 *   · 信息卡内容需求 = max(140, contentEdH || 140)（编辑器下限 / 手动高度）；
 *   · JSON 卡内容需求 = 算子列表**子元素实测和 + space-y 间距** —— 不能用
 *     scrollHeight：内容少于可视时 scrollHeight 会虚报成可视高，测不出
 *     「需求已低于分配」，导致删算子后网格缩不回去。
 */
function recomputeAuto() {
    if (window.innerWidth < 1024) {
        // 小屏本来就是堆叠流式滚动，不需要也不应该干预
        autoMinH.value = null;
        return;
    }
    const all = [...document.querySelectorAll('main .card')];
    const info = all.find((c) => (c.innerText || '').trimStart().startsWith('基本信息'));
    const json = all.find((c) => (c.innerText || '').trimStart().startsWith('JSON 脚本处理'));
    const list = json?.querySelector('[data-op-list]');
    if (!info || !json || !list) {
        autoMinH.value = null;
        return;
    }
    const ed = info.querySelector('.code-editor');

    // 一屏基线：只在网格未被顶高（autoMinH=null）时记录一次
    if (oneScreenH.value == null) {
        const grid = document.querySelector('main .grid');
        if (grid) oneScreenH.value = Math.round(grid.getBoundingClientRect().height);
    }

    // 列表内容实高：子元素求和 + space-y-2（8px）间距
    const kids = [...list.children];
    const listContent = kids.length
        ? kids.reduce((s, k) => s + k.offsetHeight, 0) + Math.max(0, kids.length - 1) * 8
        : 0;

    const infoChrome = ed ? info.offsetHeight - ed.offsetHeight : 0;
    // 编辑器需求三分支：
    //   · 手动拖动：edDragMinH 独立顶网格，不参与拉伸态判定（否则拖大会
    //     误触发 jsonFlexNone，预览 self-start + mb-16，底边对齐被误破）
    //   · 拉伸态（⤢ 切换）：内容完整展开（.cm-content 实高，不用 scrollHeight
    //     —— 内容少时它虚报为可视高，同 JSON 卡坑），上限 EDITOR_MAX
    //   · 默认态：EDITOR_MIN —— 编辑器保持新建空白时的紧凑尺寸，
    //     内容多转编辑器内部滚动，不自动变高
    let edNeed = EDITOR_MIN;
    if (ed) {
        if (contentEdH.value != null) {
            edNeed = EDITOR_MIN;
        } else if (edExpanded.value) {
            const ch = (ed.querySelector('.cm-content')?.offsetHeight ?? 0) + 16;
            edNeed = Math.min(Math.max(ch, EDITOR_MIN), EDITOR_MAX);
        }
    }
    const infoNeed = ed ? infoChrome + Math.max(EDITOR_MIN, edNeed) : info.scrollHeight;
    const jsonChrome = json.offsetHeight - list.offsetHeight;
    const jsonNeed = jsonChrome + listContent;
    const rightNeed = Math.round(infoNeed + JSON_GAP + jsonNeed);
    const need = Math.round(rightNeed);
    // over 判定：需求超过一屏基线（动态，随视口）才进拉伸态。
    // 容差 8px：flex 分配与需求测量天然差几个像素（flex 收缩 vs max-content），
    // 容差太小会让「恰好贴着一屏」的内容误触发拉伸态。
    const threshold = oneScreenH.value != null ? oneScreenH.value + 8 : 690;
    const over = need > threshold;
    autoMinH.value = over ? need : null;
    jsonFlexNone.value = over;
}

function resetEdHeight() {
    contentEdH.value = null;
    edDragMinH.value = null;
    gridBaseH.value = null;
    edExpanded.value = false; // ↺ 恢复的语义含退出拉伸态
    nextTick(recomputeAuto);
}

/** ⤢/⤡ 切换：拉伸 = 内容完整展开（上限放开）；默认 = 自适应（800 上限） */
function toggleEdExpand() {
    // 切换前清手动拖动状态，两个互斥：按钮切换以内容自适应为基础
    if (contentEdH.value != null) resetEdHeight();
    edExpanded.value = !edExpanded.value;
    nextTick(recomputeAuto);
}

// 算子增删/改参、视口变化都会改变 JSON 卡内容需求 → 重算
watch(() => form.process, () => nextTick(recomputeAuto), { deep: true });
// 节点内容变化不重算：默认态编辑器保持紧凑尺寸（内容内滚），
// 拉伸态高度由 ⤢ 点击时一次性算定
onMounted(() => {
    nextTick(recomputeAuto);
    // 视口变化 → 一屏基线失效 → 先清顶高回一屏，重排后记新基线再重算
    window.addEventListener('resize', () => {
        oneScreenH.value = null;
        autoMinH.value = null;
        jsonFlexNone.value = false;
        nextTick(recomputeAuto);
    });
});
onBeforeUnmount(() => {
    window.removeEventListener('resize', recomputeAuto);
});

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
