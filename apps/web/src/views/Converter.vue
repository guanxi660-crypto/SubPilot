<template>
    <div class="p-6 md:p-10 max-w-6xl mx-auto">
        <div>
            <h1 class="text-2xl font-bold">转换</h1>
            <p class="text-slate-500 text-sm mt-1">
                生成各客户端订阅链接，转换由 SubConverter-Extended 完成
            </p>
        </div>

        <!-- 输入源 + 参数：合并为一个模块，内部用分隔线分区 -->
        <div class="card p-5 mt-6 fade-up">
            <!-- 输入源 -->
            <div class="text-sm font-semibold">输入源</div>
            <div class="grid lg:grid-cols-2 gap-4 mt-3">
                <div>
                    <label class="text-xs text-slate-500">本站订阅 / 组合（可多选，逐条递交，每条独立成一个 Provider）</label>
                    <div class="flex flex-wrap gap-2 mt-2 max-h-40 overflow-auto p-1">
                        <button
                            v-for="s in subs"
                            :key="'s' + s.name"
                            class="px-3 py-1.5 rounded-xl text-xs border transition"
                            :class="picked.includes('sub:' + s.name)
                                ? 'border-accent/60 bg-accent/15 text-white'
                                : 'border-line bg-panel2 text-slate-400 hover:text-slate-200'"
                            @click="toggle('sub:' + s.name)"
                        >▤ {{ s.displayName || s.name }}</button>
                        <button
                            v-for="c in collections"
                            :key="'c' + c.name"
                            class="px-3 py-1.5 rounded-xl text-xs border transition"
                            :class="picked.includes('col:' + c.name)
                                ? 'border-accent/60 bg-accent/15 text-white'
                                : 'border-line bg-panel2 text-slate-400 hover:text-slate-200'"
                            @click="toggle('col:' + c.name)"
                        >⊕ {{ c.displayName || c.name }}</button>
                        <span v-if="!subs.length && !collections.length" class="text-xs text-slate-600">
                            还没有订阅，先去「订阅」页创建
                        </span>
                    </div>
                </div>
                <div>
                    <label class="text-xs text-slate-500">外部地址（一行一个，与上面的选择叠加）</label>
                    <textarea
                        v-model="form.url"
                        class="input mt-1.5 font-mono !text-xs resize-y"
                        rows="4"
                        placeholder="https://example.com/sub"
                    ></textarea>
                </div>
            </div>

            <div class="grid lg:grid-cols-2 gap-4 mt-4">
                <div>
                    <label class="text-xs text-slate-500">目标格式</label>
                    <select v-model="form.target" class="input mt-1.5">
                        <optgroup v-for="g in targetGroups" :key="g.name" :label="g.name">
                            <option v-for="t in g.items" :key="t.value" :value="t.value">{{ t.label }}</option>
                        </optgroup>
                    </select>
                </div>
                <div>
                    <label class="text-xs text-slate-500">外部配置 / 模板</label>
                    <ConfigSelect v-model="form.config" />
                    <div class="text-[11px] text-slate-600 mt-1 leading-relaxed">
                        决定策略组结构。默认用
                        <a
                            href="https://github.com/Aethersailor/Custom_OpenClash_Rules"
                            target="_blank"
                            rel="noreferrer"
                            class="text-accent2 hover:underline"
                        >Custom_OpenClash_Rules</a>
                        同款底稿 <code>Custom_Clash.ini</code>。
                    </div>
                </div>
            </div>

            <!-- 转换后端：并入同一模块、放在参数上面 —— 转换时最常动的就是它。
                 外部配置不再在这里设默认值：输入源区的「外部配置 / 模板」支持自定义地址，
                 改一次就跟着表单走，单独一个「默认外部配置」字段属于重复设置。 -->
            <div class="border-t border-line mt-5 pt-5">
                <div class="flex items-center gap-2 flex-wrap">
                    <div class="text-sm font-semibold">转换后端</div>
                    <span
                        class="w-2 h-2 rounded-full inline-block"
                        :class="srv.probing
                            ? 'bg-sky-400 animate-pulse'
                            : srv.online ? 'bg-emerald-400' : 'bg-amber-400'"
                    ></span>
                    <span class="text-xs text-slate-500">
                        <!-- 探活要打一次真实的 SCE 往返（冷启动 1s+），中间态必须和「确实连不上」区分开，
                             否则用户会看到一秒的「未响应」，以为后端挂了 -->
                        {{ srv.probing ? '检测中…' : srv.online ? `在线 ${srv.version || ''}` : srv.error || '未响应' }}
                    </span>
                    <a
                        v-if="srv.effectiveBackend"
                        :href="`${srv.effectiveBackend}/inspect`"
                        target="_blank"
                        rel="noreferrer"
                        class="text-[11px] text-accent2 hover:underline ml-auto"
                    >诊断台 ↗</a>
                </div>

                <div class="grid sm:grid-cols-2 gap-4 mt-4">
                    <div>
                        <label class="text-xs text-slate-500">转换后端地址</label>
                        <input
                            v-model="srv.subBackend"
                            class="input mt-1.5 font-mono !text-xs"
                            :placeholder="srv.envBackend || 'https://api.asailor.org'"
                        />
                        <div class="text-[11px] text-slate-600 mt-1 leading-relaxed">
                            留空则使用部署时配置的转换后端。
                            兼容 SubConverter 与 SubConverter-Extended 后端，建议使用自建后端。
                            转换后端主要为 mihomo 系列客户端转换分流远程订阅使用，其它客户端的基础功能已经够用；
                            转换后端为开源项目，部分客户端没有实测，请自行测试。
                        </div>
                    </div>
                    <div>
                        <label class="text-xs text-slate-500">默认目标格式</label>
                        <select v-model="srv.defaultTarget" class="input mt-1.5">
                            <optgroup v-for="g in targetGroups" :key="g.name" :label="g.name">
                                <option v-for="t in g.items" :key="t.value" :value="t.value">{{ t.label }}</option>
                            </optgroup>
                        </select>
                        <div class="text-[11px] text-slate-600 mt-1">进入本页时「目标格式」的初值。</div>
                    </div>
                </div>

                <div class="flex gap-2 mt-4">
                    <button class="btn-ghost text-xs" :disabled="srv.saving" @click="saveServer">
                        {{ srv.saving ? '保存中…' : '保存' }}
                    </button>
                    <button class="btn-ghost text-xs" :disabled="srv.saving" @click="loadServer">↻ 重新探测</button>
                    <!-- 转换按钮放在这里：它按上面的输入源 + 参数 + 后端设置去跑一次转换 -->
                    <button
                        class="btn-primary text-xs ml-auto !px-5"
                        :disabled="running"
                        @click="run"
                    >{{ running ? '转换中…' : '▶ 转换' }}</button>
                </div>
            </div>

            <!-- 参数：默认折叠，展开后才占版面 -->
            <div class="border-t border-line mt-5 pt-5">
                <button
                    class="flex items-center gap-2 w-full text-left"
                    @click="showParams = !showParams"
                >
                    <span class="text-sm font-semibold">参数</span>
                    <span
                        class="text-[11px] px-2 py-0.5 rounded-full border"
                        :class="paramCount
                            ? 'border-accent/40 text-accent2'
                            : 'border-line text-slate-600'"
                    >{{ paramCount ? `${paramCount} 项已设置` : '全部默认' }}</span>
                    <span class="ml-auto text-xs text-slate-500">{{ showParams ? '收起 ▴' : '展开 ▾' }}</span>
                </button>

                <div v-show="showParams" class="mt-3">
                    <div>
                        <div class="text-xs text-slate-500 mb-2">开关</div>
                        <div class="flex flex-wrap gap-2">
                            <button
                                v-for="t in TOGGLES"
                                :key="t.key"
                                class="px-3 py-1.5 rounded-xl text-xs border transition"
                                :title="t.hint"
                                :class="form[t.key]
                                    ? 'border-accent/60 bg-accent/15 text-white'
                                    : 'border-line bg-panel2 text-slate-400 hover:text-slate-200'"
                                @click="form[t.key] = !form[t.key]"
                            >{{ t.label }}</button>
                        </div>
                        <div class="text-[11px] text-slate-600 mt-2 leading-relaxed">
                            ⚠ 「地区旗帜」默认不勾选，此时后端会收到显式的 <code>emoji=false</code>，
                            也就是<strong>真的不加旗</strong>。勾选状态即最终值。
                        </div>
                    </div>

                    <div class="mt-4 grid sm:grid-cols-2 gap-3">
                        <div>
                            <label class="text-xs text-slate-500">排除节点（正则，<code>|</code> 分隔）</label>
                            <input v-model="form.exclude" class="input mt-1.5 font-mono !text-xs" placeholder="(?i)剩余|官网" />
                        </div>
                        <div>
                            <label class="text-xs text-slate-500">保留节点（正则）</label>
                            <input v-model="form.include" class="input mt-1.5 font-mono !text-xs" placeholder="(?i)hk|jp" />
                        </div>
                    </div>

                    <div class="mt-3">
                        <label class="text-xs text-slate-500">重命名规则（<code>模式@替换</code>，多条用 <code>`</code> 分隔）</label>
                        <input v-model="form.rename" class="input mt-1.5 font-mono !text-xs" placeholder="(?i)香港@HK" />
                    </div>

                    <div class="mt-3 grid sm:grid-cols-2 gap-3">
                        <div>
                            <label class="text-xs text-slate-500">文件名</label>
                            <input v-model="form.filename" class="input mt-1.5 font-mono !text-xs" placeholder="留空由后端决定" />
                        </div>
                        <div>
                            <label class="text-xs text-slate-500">策略组名</label>
                            <input v-model="form.group" class="input mt-1.5 font-mono !text-xs" />
                        </div>
                    </div>

                    <div class="mt-3">
                        <label class="text-xs text-slate-500">脚本处理</label>
                        <div class="text-[11px] text-slate-600 mt-1.5 leading-relaxed">
                            勾选的本站订阅会带上它们各自的 JSON 脚本 —— 脚本在「订阅」页的编辑界面里配置。
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 结果 -->
        <div class="card p-5 mt-4 fade-up" style="--d:150ms">
            <div class="flex items-center gap-3 flex-wrap">
                <div class="text-sm font-semibold">产出</div>
                <span v-if="result.status" class="text-xs" :class="result.ok ? 'text-emerald-300/90' : 'text-rose-300/80'">
                    {{ result.status }}
                </span>
                <div class="ml-auto flex gap-2">
                    <button class="btn-ghost !py-1 text-xs" :disabled="!result.body" @click="copyResultLink">⧉ 复制链接</button>
                    <button class="btn-ghost !py-1 text-xs" :disabled="!result.body" @click="downloadBody">⤓ 下载</button>
                    <button class="btn-ghost !py-1 text-xs" :disabled="!result.body" @click="openSave">保存成品</button>
                </div>
            </div>

            <div v-if="shareLink" class="mt-3 bg-panel2 rounded-xl p-3">
                <div class="text-[11px] text-emerald-300/90">
                    分发链接（带派生只读密钥，可直接发给别人 / 粘进客户端）
                </div>
                <div class="text-xs font-mono break-all mt-1.5">{{ shareLink }}</div>
                <div v-if="feedUrl" class="text-[11px] text-slate-600 font-mono break-all mt-1.5">
                    feed：{{ feedUrl }}
                </div>
            </div>

            <!-- 预览链接（带管理令牌）不在这里显示：它是排障用的，摆出来容易被误当成可外发的地址。
                 需要时直接从地址栏复制即可。 -->

            <pre
                v-if="result.body"
                class="mt-3 bg-panel2 rounded-xl p-3 text-[11px] font-mono max-h-[50vh] overflow-auto whitespace-pre-wrap break-all"
            >{{ result.body }}</pre>
            <div v-else class="text-xs text-slate-600 mt-3">
                点「转换后端」里的「转换」生成结果。产出会原样展示，不做截断 —— 大配置请用「下载」。
            </div>
        </div>

        <!-- 成品：保存过的快照列表。以前保存成功后界面上毫无踪迹，
             概览的「全部 ›」又跳回本页 —— 而本页偏偏没有列表，这就是「保存了却没见新卡片」的根因 -->
        <div class="card p-5 mt-4 fade-up" style="--d:200ms">
            <div class="flex items-center gap-3 flex-wrap">
                <div class="text-sm font-semibold">成品</div>
                <span class="text-[10px] px-2 py-0.5 rounded-full border border-line text-slate-400">
                    固定分享链接 · 重存即更新内容
                </span>
                <button class="btn-ghost !py-1 text-xs ml-auto" :disabled="cards.loading" @click="loadCards">
                    ↻ 刷新
                </button>
            </div>

            <div v-if="cards.items.length" class="mt-3 grid md:grid-cols-2 gap-3">
                <div
                    v-for="c in cards.items"
                    :key="c.name"
                    class="bg-panel2 rounded-xl p-3"
                >
                    <div class="flex items-center gap-2">
                        <span class="text-xs font-semibold truncate" :title="c.name">{{ c.name }}</span>
                        <span class="type-badge type-default shrink-0">{{ c.target || '通用' }}</span>
                        <button
                            class="btn-ghost !py-0.5 !px-2 !text-[11px] ml-auto shrink-0"
                            :disabled="cards.downloading === c.name"
                            @click="downloadCard(c)"
                        >{{ cards.downloading === c.name ? '下载中…' : '⤓ 下载' }}</button>
                    </div>
                    <div class="text-[11px] text-slate-600 mt-1.5">
                        {{ fmtSize(c.size) }} · 保存于 {{ fmtTime(c.updatedAt || c.createdAt) }}
                    </div>

                    <!-- 分享链接做成按钮（与订阅卡片操作行对齐）：保存成品那一刻后端就建好了，
                         之后重转 / 重存都不会变 —— 点一次生成一次的语义对成品是错的，
                         客户端配置里嵌的地址一换，所有人都得重新分发。 -->
                    <div class="flex items-center gap-1.5 mt-2.5 flex-wrap">
                        <TgPushButton compact kind="converted" :name="c.name" :label="c.name" />
                        <button
                            class="btn-ghost !py-0.5 !px-2 !text-[11px] whitespace-nowrap shrink-0"
                            :disabled="!c.shareCode"
                            :title="c.shareCode ? '复制分享链接' : '分享链接生成中，稍后刷新'"
                            @click="copyCard(c)"
                        >{{ copied === c.name ? '✓ 已复制' : '⧉ 分享链接' }}</button>
                        <button
                            class="btn-ghost !py-0.5 !px-2 !text-[11px] !text-rose-300/80 ml-auto"
                            :disabled="cards.deleting === c.name"
                            @click="delCard(c)"
                        >删除</button>
                    </div>
                </div>
            </div>
            <div v-else class="text-xs text-slate-600 mt-3">
                还没有成品。转换成功后点上方「保存成品」，这里会出现带固定分享链接的卡片，
                也能推到 Telegram。
            </div>
        </div>

        <!-- 保存成品 -->
        <div
            v-if="save.open"
            class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-y-auto py-16 px-4"
            @click.self="save.open = false"
        >
            <div class="card w-full max-w-lg p-6">
                <div class="font-semibold">保存成品</div>
                <div class="text-xs text-slate-500 mt-2 leading-relaxed">
                    成品保存的是<strong>转换产物</strong>：分享链接固定不变，
                    重新保存会更新内容（链接地址不变，客户端无需重新导入）。
                    要换格式请回到本页改 target 重转；不能再被当作转换输入。
                </div>
                <div class="mt-4">
                    <label class="text-xs text-slate-500">分发名称（1–64 字符，不含 / \ ? # %）</label>
                    <input v-model="save.name" class="input mt-1.5 font-mono" />
                </div>
                <div class="flex justify-end gap-2 mt-5">
                    <button class="btn-ghost text-xs" @click="save.open = false">取消</button>
                    <button class="btn-primary text-xs" :disabled="save.busy" @click="doSave">
                        {{ save.busy ? '保存中…' : '保存' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { api } from '../stores/auth.js';
import { loadOperatorMeta, sceTargets } from '../stores/operators.js';
import { validateName } from '../utils/name.js';
import { DEFAULT_CONFIG_URL } from '../utils/configPresets.js';
import ConfigSelect from '../components/ConfigSelect.vue';
import TgPushButton from '../components/TgPushButton.vue';
import { shareUrl } from '../utils/share.js';

const route = useRoute();
const router = useRouter();
const message = useMessage();

const subs = ref([]);
const collections = ref([]);
const picked = ref([]);
const running = ref(false);

const form = reactive({
    url: '',
    target: 'clash',
    config: DEFAULT_CONFIG_URL,
    // 开关一律默认关闭。buildParams 里 emoji 会显式传最终值，
    // 所以「不勾选」= 后端收到 emoji=false = 真的不加旗，语义是确定的。
    emoji: false,
    udp: false,
    tfo: false,
    scv: false,
    sort: false,
    fdn: false,
    list: false,
    append_type: false,
    expand: false,
    classic: false,
    exclude: '',
    include: '',
    rename: '',
    filename: '',
    group: '',
});

// 参数区默认折叠：绝大多数转换只用默认值，摊开会把输入源挤下去
const showParams = ref(false);

const result = reactive({ ok: false, status: '', body: '' });
const save = reactive({ open: false, name: '', busy: false });
/** 可外发的分发链接（带派生只读密钥，不含管理令牌） */
const shareLink = ref('');
const feedUrl = ref('');

// 已保存的成品列表 —— 保存动作必须能在这页看到结果，而不是只在概览里默默出现
const cards = reactive({ items: [], loading: false, downloading: '', deleting: '' });
/** 「复制」按钮的瞬时反馈：记录刚复制成功的成品名，1.5s 后还原 */
const copied = ref('');

// 转换后端配置 —— 并入上方主卡片：转换时最常需要切后端 / 换目标格式。
const srv = reactive({
    subBackend: '',
    defaultTarget: 'clash',
    envBackend: '',
    effectiveBackend: '',
    online: false,
    version: '',
    error: '',
    probing: false,
    saving: false,
});

const TOGGLES = [
    { key: 'emoji', label: '地区旗帜', hint: 'emoji：加国旗' },
    { key: 'udp', label: '强制 UDP', hint: 'udp' },
    { key: 'tfo', label: 'TCP Fast Open', hint: 'tfo' },
    { key: 'scv', label: '跳过证书验证', hint: 'scv，会降低安全性' },
    { key: 'sort', label: '按名称排序', hint: 'sort' },
    { key: 'fdn', label: '过滤失效节点', hint: 'fdn' },
    { key: 'append_type', label: '名称追加类型', hint: 'append_type' },
    { key: 'list', label: '仅节点列表', hint: 'list：不生成完整配置' },
    { key: 'expand', label: '展开规则集', hint: 'expand' },
    { key: 'classic', label: 'classical Provider', hint: 'classic' },
];

/** 折叠状态下也要能看出「有没有改过参数」，否则隐藏的开关会变成暗坑 */
const paramCount = computed(() => {
    let n = TOGGLES.filter((t) => form[t.key]).length;
    for (const k of ['exclude', 'include', 'rename', 'filename', 'group']) {
        if (String(form[k] || '').trim()) n += 1;
    }
    return n;
});

const targetGroups = computed(() => {
    // 兜底：接口没回来时也要有得选。内容与 sce.js 的 SCE_TARGETS 保持一致，
    // 改一边记得改另一边（完整清单见 docs/目标格式体检报告.md）。
    const src = sceTargets.value.length
        ? sceTargets.value
        : [
              { value: 'clash', label: 'Clash / Mihomo', group: 'Mihomo Provider' },
              { value: 'singbox', label: 'sing-box', group: '完整配置转换' },
              { value: 'shadowrocket', label: 'Shadowrocket', group: '简单订阅输出' },
              { value: 'trojan', label: 'Trojan', group: '简单订阅输出' },
              { value: 'vless', label: 'VLESS', group: '简单订阅输出' },
              { value: 'hysteria2', label: 'Hysteria2', group: '简单订阅输出' },
              { value: 'ss', label: 'SS', group: '简单订阅输出' },
              { value: 'ssr', label: 'SSR', group: '简单订阅输出' },
          ];
    const map = new Map();
    for (const t of src) {
        const g = t.group || '其它';
        if (!map.has(g)) map.set(g, []);
        map.get(g).push(t);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
});

function toggle(key) {
    const i = picked.value.indexOf(key);
    if (i >= 0) picked.value.splice(i, 1);
    else picked.value.push(key);
}

/** 构造请求本站 /sub 的查询串 */
function buildParams() {
    const qs = new URLSearchParams();
    qs.set('target', form.target);

    // 来源：选中的订阅/组合 + 手填地址
    const urls = [];
    const subNames = [];
    const colNames = [];
    for (const p of picked.value) {
        if (p.startsWith('sub:')) subNames.push(p.slice(4));
        else colNames.push(p.slice(3));
    }
    for (const u of form.url.split(/[\r\n|]+/).map((x) => x.trim()).filter(Boolean)) urls.push(u);

    if (subNames.length === 1 && !colNames.length && !urls.length) {
        qs.set('sub', subNames[0]);
    } else if (colNames.length === 1 && !subNames.length && !urls.length) {
        qs.set('collection', colNames[0]);
    } else {
        // 多来源：交给后端的 url 列表（后端逐条解析、每条一个命名 Provider）
        // 多来源：组合不参与（上面已提示），只递交订阅引用与外部地址
        const all = [
            ...subNames.map((n) => `sp://${n}`),
            ...urls,
        ];
        if (colNames.length) {
            // 组合是合并语义（单 feed 单 provider），混选逐条递交时无法混入 —— 明确丢弃并提示
            message.warning('多来源混选时不包含组合 —— 组合请单独转换，或转成组合的分发链接。');
        }
        if (all.length) qs.set('url', all.join('|'));
    }

    if (form.config.trim()) qs.set('config', form.config.trim());
    if (form.group.trim()) qs.set('group', form.group.trim());
    if (form.filename.trim()) qs.set('filename', form.filename.trim());
    if (form.exclude.trim()) qs.set('exclude', form.exclude.trim());
    if (form.include.trim()) qs.set('include', form.include.trim());
    if (form.rename.trim()) qs.set('rename', form.rename.trim());

    // 开关：只有 fdn 是"默认关"，其余默认由后端决定 —— 所以显式传最终值
    qs.set('emoji', form.emoji ? 'true' : 'false');
    for (const k of ['udp', 'tfo', 'scv', 'sort', 'fdn', 'append_type', 'list', 'expand', 'classic']) {
        if (form[k]) qs.set(k, 'true');
    }

    const t = localStorage.getItem('sp_token');
    if (t) qs.set('token', t);
    return qs;
}

function refreshLink() {
    const subNames = picked.value.filter((p) => p.startsWith('sub:')).map((p) => p.slice(4));
    const colNames = picked.value.filter((p) => p.startsWith('col:')).map((p) => p.slice(3));
    const extra = form.url.split(/[\r\n|]+/).map((x) => x.trim()).filter(Boolean);
    const total = subNames.length + colNames.length + extra.length;
    if (!total) {
        shareLink.value = '';
        feedUrl.value = '';
        return;
    }

    // 单个本站订阅 / 组合：直接按名字寻址。
    if (subNames.length + colNames.length === 1 && !extra.length) {
        const kind = subNames.length ? 'sub' : 'col';
        const name = subNames[0] || colNames[0];
        const q = new URLSearchParams({ kind, name });
        if (form.target) q.set('target', form.target);
        api(`/api/link?${q.toString()}`)
            .then((res) => {
                shareLink.value = res.data.link;
                feedUrl.value = res.data.feedUrl;
            })
            .catch(() => {
                shareLink.value = '';
                feedUrl.value = '';
            });
        return;
    }

    // 多来源：选择本身没有名字可以寻址，后端把它折成一个 adhoc spec 再走同一套派生密钥。
    // 以前这里直接把 shareLink / feedUrl 清空 —— 表现成「多选几个订阅，分发链接整个消失」，
    // 用户手里就只剩下带管理令牌的预览链接，等于没法把多来源的结果发出去。
    //
    // 来源取舍必须和 buildParams 完全一致：混选时组合被丢弃（那边有警告提示），
    // 这里要是把组合也算进 spec，链接和实际转换的内容就对不上了。
    const body = {
        sources: [...subNames.map((n) => `sp://${n}`), ...extra],
        target: form.target,
    };
    api('/api/link', { method: 'POST', body: JSON.stringify(body) })
        .then((res) => {
            shareLink.value = res.data.link;
            feedUrl.value = res.data.feedUrl;
        })
        .catch(() => {
            shareLink.value = '';
            feedUrl.value = '';
        });
}

// ---- 转换后端配置 ----

async function loadServer() {
    try {
        const res = await api('/api/settings');
        const d = res.data || {};
        srv.subBackend = d.subBackend || '';
        srv.defaultTarget = d.defaultTarget || 'clash';
        srv.envBackend = d.envBackend || '';
        srv.effectiveBackend = d.effectiveBackend || '';
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }
    // 在线状态只有 /api/utils/env 才有，所以读完设置顺手探活一次
    await probeBackend();
}

/** 探活转换后端：拿到在线状态、SCE 版本与错误信息 */
async function probeBackend() {
    srv.probing = true;
    try {
        const res = await api('/api/utils/env');
        const d = res.data || {};
        srv.online = !!d.online;
        srv.version = d.sceVersion || '';
        srv.error = d.error || '';
        if (d.subBackend) srv.effectiveBackend = d.subBackend;
    } catch {
        srv.online = false;
    } finally {
        srv.probing = false;
    }
}

async function saveServer() {
    srv.saving = true;
    try {
        // 只提交本区还留着的字段。「默认外部配置」的输入框已经删掉
        // （输入源区的「外部配置 / 模板」支持自定义地址，字段重复），不提交就不会被误清。
        await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({
                subBackend: srv.subBackend,
                defaultTarget: srv.defaultTarget,
            }),
        });
        message.success('已保存');
        await loadServer();
    } catch (e) {
        message.error(e.message);
    } finally {
        srv.saving = false;
    }
}

// ---- 成品列表 ----

async function loadCards() {
    cards.loading = true;
    try {
        const res = await api('/api/converted');
        cards.items = res.data || [];
    } catch {
        /* 列表加载失败不该挡住转换本身 */
    } finally {
        cards.loading = false;
    }
}

async function downloadCard(c) {
    cards.downloading = c.name;
    try {
        const res = await api(`/api/converted/${encodeURIComponent(c.name)}`);
        const blob = new Blob([res.data?.content || ''], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = c.name;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        message.error(e.message);
    } finally {
        cards.downloading = '';
    }
}

/**
 * 成品的固定分享链接。
 *
 * 链接是「保存即定下、之后永不变」的 —— 码由后端在保存时自动生成并挂到列表项上，
 * 所以这里没有任何「生成 / 刷新」动作，只有展示与复制。
 */
function convertedShareUrl(c) {
    return shareUrl({ type: 'converted', name: c.name, code: c.shareCode });
}

async function copyCard(c) {
    try {
        await navigator.clipboard.writeText(convertedShareUrl(c));
        copied.value = c.name;
        setTimeout(() => {
            if (copied.value === c.name) copied.value = '';
        }, 1500);
    } catch {
        message.error('复制失败，请手动选中链接复制');
    }
}

async function delCard(c) {
    if (!window.confirm(`删除成品「${c.name}」？此操作不可恢复，它的固定分享链接也会一并失效。`)) return;
    cards.deleting = c.name;
    try {
        const res = await api(`/api/converted/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
        cards.items = res.data || [];
        message.success('成品已删除');
    } catch (e) {
        message.error(e.message);
    } finally {
        cards.deleting = '';
    }
}

function fmtSize(n) {
    const v = Number(n) || 0;
    return v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB` : `${(v / 1024).toFixed(1)} KB`;
}

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { hour12: false });
}

// ---- 选择同步到地址栏 ----
// 点订阅源 / 改目标格式都会即时写进 URL，这样当前配置可以直接收藏或整条发给别人；
// 进来时再从 URL 恢复（见 onMounted）。用 replace 而不是 push，避免把历史记录刷满。
function syncQuery() {
    const subNames = picked.value.filter((p) => p.startsWith('sub:')).map((p) => p.slice(4));
    const colNames = picked.value.filter((p) => p.startsWith('col:')).map((p) => p.slice(3));
    const q = {};
    if (subNames.length) q.sub = subNames;
    if (colNames.length) q.col = colNames;
    if (form.target) q.target = form.target;
    router.replace({ path: '/converter', query: q });
}

async function run() {
    if (!picked.value.length && !form.url.trim()) {
        return message.error('请至少选择一个订阅，或填写一个外部地址');
    }
    refreshLink();
    running.value = true;
    result.status = '转换中…';
    result.ok = false;
    result.body = '';
    try {
        const qs = buildParams();
        const res = await fetch(`/sub?${qs.toString()}`);
        const body = await res.text();
        result.body = body;
        result.ok = res.ok;
        if (res.ok) {
            const nodes = res.headers.get('X-SubPilot-Processed');
            // 服务端下发的是 local / passthrough 两个内部标识，原样显示用户看不懂。
            // 字节数也要按 UTF-8 真算 —— body.length 数的是 UTF-16 码元，中文会少一半。
            const how = nodes === 'local' ? '本站改写节点后转换' : '直接由转换后端转换';
            const bytes = new TextEncoder().encode(body).length;
            result.status = `成功 · ${bytes} 字节 · ${how}`;
        } else {
            result.status = `失败（HTTP ${res.status}）`;
        }
    } catch (e) {
        result.status = `请求失败：${e.message}`;
    } finally {
        running.value = false;
    }
}

/**
 * 「复制链接」：把本次转换结果以链接形式复制出去，而不是复制响应体。
 * 优先复制分发链接（带派生只读密钥，可直接发给别人 / 粘进客户端）；
 * 直连等没有分发链接的形态，回退用当前转换参数拼出 /sub?... 直链。
 */
function copyResultLink() {
    const link = shareLink.value || `${location.origin}/sub?${buildParams().toString()}`;
    navigator.clipboard.writeText(link).then(
        () => message.success('转换链接已复制，可直接发给别人或粘进客户端'),
        () => message.error('复制失败，请手动复制'),
    );
}

function downloadBody() {
    const ext = form.target === 'clash' ? 'yaml' : form.target === 'singbox' ? 'json' : 'txt';
    const blob = new Blob([result.body], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = form.filename || `subpilotx-${form.target}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function openSave() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    save.name = `${form.target}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    save.open = true;
}

async function doSave() {
    const name = String(save.name || '').trim();
    const nameErr = validateName(name, { label: '分发名称', maxLen: 64 });
    if (nameErr) return message.error(nameErr);
    save.busy = true;
    try {
        await api('/api/converted', {
            method: 'POST',
            body: JSON.stringify({ name, target: form.target, template: form.config, content: result.body }),
        });
        message.success('成品已保存');
        save.open = false;
        // 立刻把新成品亮出来 —— 保存必须「看得见」，这是本轮修的 bug
        await loadCards();
    } catch (e) {
        message.error(e.message);
    } finally {
        save.busy = false;
    }
}

/** 地址栏里的选择是否已经和表单一致（用来判断一次 query 变化要不要回灌） */
function queryMatchesState() {
    const subsQ = [].concat(route.query.sub || []);
    const colsQ = [].concat(route.query.col || []);
    const curSubs = picked.value.filter((p) => p.startsWith('sub:')).map((p) => p.slice(4));
    const curCols = picked.value.filter((p) => p.startsWith('col:')).map((p) => p.slice(3));
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    return same(subsQ, curSubs) && same(colsQ, curCols) && (route.query.target || 'clash') === form.target;
}

/**
 * 把地址栏里的选择回灌到表单。
 * 已删除的项静默丢弃 —— 不让一个失效的书签把页面卡住。
 * resetConfig 只在首次挂载时为 true，避免回灌把用户手填的配置清掉。
 */
function applyQuery({ resetConfig = false } = {}) {
    const q = route.query;
    const subsQ = [].concat(q.sub || []);
    const colsQ = [].concat(q.col || []);
    const validSubs = new Set(subs.value.map((x) => x.name));
    const validCols = new Set(collections.value.map((x) => x.name));
    picked.value = [
        ...subsQ.filter((n) => validSubs.has(n)).map((n) => `sub:${n}`),
        ...colsQ.filter((n) => validCols.has(n)).map((n) => `col:${n}`),
    ];
    if (q.target) form.target = q.target;
    else if (resetConfig) form.target = srv.defaultTarget || 'clash';
    // 外部配置不再有「默认值」一说了：统一落到内置默认（SubPilot-Archive 同款底稿），
    // 要换就在输入源区的「外部配置 / 模板」里选或填自定义地址
    if (resetConfig) form.config = DEFAULT_CONFIG_URL;
}

onMounted(async () => {
    await loadOperatorMeta();
    await loadServer();
    try {
        const [s, c] = await Promise.all([api('/api/subs'), api('/api/collections')]);
        subs.value = s.data || [];
        collections.value = c.data || [];
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }

    applyQuery({ resetConfig: true });

    refreshLink();
    syncQuery();
    loadCards();
});

// 选择 / 目标格式一变就同步地址栏并刷新分发链接，
// 不用等点「转换」才看到链接。
watch(
    [picked, () => form.target],
    () => {
        syncQuery();
        refreshLink();
    },
    { deep: true },
);

// 已经在转换页时，从外部改掉 query（粘贴一条分享来的链接、浏览器前进后退）
// **不会重新挂载组件**，onMounted 也就不会再跑一次 —— 结果就是「地址栏写着选了 A、
// 界面却没选」。这里手动补一次回灌。
// 先比对状态再动手：自己 syncQuery 写出去的 query 一定和状态一致，因此天然不会来回打架。
watch(
    () => route.fullPath,
    () => {
        if (queryMatchesState()) return;
        applyQuery();
        refreshLink();
    },
);
</script>
