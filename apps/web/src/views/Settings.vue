<template>
    <div class="p-6 md:p-10 max-w-4xl mx-auto">
        <div>
            <h1 class="text-2xl font-bold">设置</h1>
            <p class="text-slate-500 text-sm mt-1">外观、分发与 AI 接口</p>
        </div>

        <!-- 外观 -->
        <div class="card p-5 mt-6 fade-up">
            <div class="text-sm font-semibold">外观</div>
            <div class="flex flex-wrap gap-2 mt-3">
                <button
                    v-for="k in THEME_ORDER"
                    :key="k"
                    class="btn-ghost !py-1.5 text-xs"
                    :class="themeMode === k ? '!border-accent/60 !text-accent2' : ''"
                    @click="setTheme(k)"
                >{{ THEME_META[k].icon }} {{ THEME_META[k].name }}</button>
            </div>
        </div>

        <!-- 分发密钥 -->
        <!-- 访问令牌卡片已移除：令牌由部署时的 SUBPILOT_TOKEN secret 固定，页面改不了它，
             输入/校验由登录页全权负责。在这里放一个「随机生成」只会造出永远 401 的假令牌。 -->
        <div class="card p-5 mt-4 fade-up" style="--d:50ms">
            <div class="text-sm font-semibold">分发密钥</div>
            <div class="text-[11px] text-slate-600 mt-1.5 leading-relaxed">
                「复制订阅」生成的链接里带的是<strong>按订阅派生的只读密钥</strong>（<code>?ft=</code>），
                而不是管理令牌 —— 拿到链接的人只能读这一个订阅，改不了任何东西。
                客户端配置里存的也是这个地址，所以这一点很重要。
            </div>
            <div class="mt-4">
                <label class="text-xs text-slate-500">对外基地址（可选）</label>
                <input
                    v-model="cfg.publicBaseUrl"
                    v-bind="NO_AUTOFILL"
                    name="sp-public-base-url"
                    class="input mt-1.5 font-mono !text-xs"
                    :placeholder="pageOrigin"
                />
                <div class="text-[11px] text-slate-600 mt-1 leading-relaxed">
                    生成 feed 链接时用。留空自动取请求来源；绑了自定义域名但后端仍走 workers.dev 时，填自定义域名。
                </div>
            </div>

            <button class="btn-ghost text-xs mt-4" :disabled="saving" @click="save">保存</button>

            <div class="flex flex-wrap gap-2 mt-4 pt-4 border-t border-line">
                <button class="btn-ghost text-xs" :disabled="busy" @click="rotateFeedKey">
                    ♻ 轮换分发密钥
                </button>
                <span v-if="rotatedAt" class="text-[11px] text-slate-500 self-center">
                    上次轮换：{{ new Date(rotatedAt).toLocaleString() }}
                </span>
            </div>
            <div class="text-[11px] text-amber-300/90 mt-3 leading-relaxed">
                ⚠ 轮换后，所有已发出的 /feed、/download 链接会立即失效，
                所有客户端都需要重新导入新的订阅地址。
            </div>
        </div>

        <!-- AI -->
        <div class="card p-5 mt-4 fade-up" style="--d:150ms">
            <div class="text-sm font-semibold">AI 助手</div>
            <div class="text-[11px] text-slate-600 mt-1.5 leading-relaxed">
                任意 OpenAI 兼容接口。Key 存在服务端 KV，不会下发到浏览器。
            </div>

            <div class="grid sm:grid-cols-2 gap-4 mt-3">
                <div>
                    <label class="text-xs text-slate-500">Base URL</label>
                    <input
                        v-model="cfg.ai.baseUrl"
                        v-bind="NO_AUTOFILL"
                        name="sp-ai-base-url"
                        class="input mt-1.5 font-mono !text-xs"
                        placeholder="https://api.openai.com/v1"
                    />
                </div>
                <div>
                    <label class="text-xs text-slate-500">模型</label>
                    <div class="flex gap-2 mt-1.5 relative" data-model-box>
                        <!-- readonly-until-focus：Chrome 只要看到页面上有裸密码框，
                             就会把旁边的文本框当「用户名」并在聚焦时弹账号列表，
                             autocomplete="off" 对这条启发式**无效**（实测仍弹）。
                             只读字段 Chrome 不会弹 —— 先只读、点进去才解锁，
                             弹窗就彻底没有了。见 utils/inputs.js。 -->
                        <input
                            v-model="cfg.ai.model"
                            v-bind="NO_AUTOFILL"
                            name="sp-ai-model"
                            class="input font-mono !text-xs flex-1"
                            placeholder="gpt-4o-mini"
                            :readonly="!modelUnlocked"
                            @focus="modelUnlocked = true; modelOpen = true"
                            @keydown.esc="modelOpen = false"
                        />
                        <button class="btn-ghost text-xs shrink-0" :disabled="busy" @click="fetchModels">
                            {{ busy ? '拉取中…' : '拉取' }}
                        </button>

                        <!-- 自绘下拉：原生 datalist 是浏览器 UI，账号弹窗能盖住它；
                             自绘面板在页面里，不受影响。聚焦模型框即弹出，
                             框里的字同时当过滤器，Esc / 点外面关闭。 -->
                        <div
                            v-if="modelOpen && models.length"
                            class="dropdown-solid absolute z-30 top-full left-0 right-0 mt-1 card p-1.5 max-h-64 overflow-auto shadow-xl"
                        >
                            <div
                                v-for="m in filteredModels"
                                :key="m"
                                class="text-xs font-mono px-2.5 py-1.5 rounded-lg cursor-pointer hover:bg-panel2 truncate"
                                :class="m === cfg.ai.model ? 'text-accent2' : 'text-slate-400'"
                                :title="m"
                                @click="cfg.ai.model = m; modelOpen = false"
                            >{{ m }}</div>
                        </div>
                    </div>
                    <div class="text-[11px] text-slate-600 mt-1">
                        <template v-if="models.length">
                            已拉取 {{ models.length }} 个
                            <template v-if="filteredModels.length !== models.length">
                                ，匹配 {{ filteredModels.length }} 个
                            </template>
                            ，点击模型框即可从列表选；自建网关的模型名可直接手填。
                        </template>
                        <template v-else>可直接手填，或点「拉取」从接口拿模型列表后点击模型框选择。</template>
                    </div>
                </div>
                <div class="sm:col-span-2">
                    <label class="text-xs text-slate-500">API Key</label>
                    <!-- 默认不渲染输入框（要改 Key 时点一下才出现），
                         且出现的是 text + 圆点伪装框：密码管理器根本不认它，
                         账号列表 / 保存密码气泡统统不会弹 —— 见 utils/inputs.js。 -->
                    <div
                        v-if="!keyEditing"
                        data-key-toggle
                        data-key-dots
                        class="input mt-1.5 font-mono !text-xs flex items-center justify-between cursor-pointer select-none"
                        @click="keyEditing = true"
                    >
                        <!-- 已保存就显示圆点串，与「同步」页的三个密钥框同一套视觉。
                             此前这里回显掩码正文（sk-1****cdef）：既把密钥的首尾各 4 位
                             摆在页面上，又和「同步」页的圆点不一致 —— 用户要确认的是
                             「存过没有」，不是「存的是什么」。掩码挪到 title 里，
                             鼠标悬停仍可核对是哪一把。 -->
                        <span
                            v-if="settings.ai?.hasApiKey"
                            class="text-slate-400 tracking-[0.2em]"
                            :title="settings.ai.apiKeyMask"
                        >••••••••</span>
                        <span v-else class="text-slate-500">未设置</span>
                        <span class="text-[11px] text-slate-600 shrink-0 ml-2">点击修改</span>
                    </div>
                    <input
                        v-else
                        ref="keyInput"
                        v-model="cfg.ai.apiKey"
                        v-bind="SECRET_FIELD"
                        name="sp-ai-api-key"
                        class="input mt-1.5 font-mono !text-xs"
                        :placeholder="settings.ai?.hasApiKey ? `已保存（${settings.ai.apiKeyMask}），留空不修改` : 'sk-...'"
                        @blur="onKeyBlur"
                    />
                </div>
            </div>

            <div class="flex gap-2 mt-4">
                <button class="btn-ghost text-xs" :disabled="saving" @click="save">保存</button>
                <button class="btn-ghost text-xs" :disabled="busy" @click="testAi">探活测试</button>
            </div>
            <div v-if="aiMsg" class="text-xs mt-3" :class="aiOk ? 'text-emerald-300/90' : 'text-rose-300/80'">
                {{ aiMsg }}
            </div>
        </div>

        <!-- 关于 -->
        <div class="card p-5 mt-4 fade-up" style="--d:200ms">
            <div class="text-sm font-semibold">关于</div>
            <div class="text-[11px] text-slate-500 mt-3 space-y-1.5 leading-relaxed">
                <div>SubPilot <span class="font-mono">{{ backend.appVersion || '0.1.0' }}</span> · AGPL-3.0</div>
                <div>
                    本项目不实现格式转换，转换层为
                    <a href="https://github.com/Aethersailor/SubConverter-Extended" target="_blank" rel="noreferrer" class="text-accent2 hover:underline">SubConverter-Extended</a>
                    （GPL-3.0）；本项目未包含其源码，仅通过 HTTP 调用其 <code>/sub</code> 接口。
                </div>
                <div>
                    当前默认转换后端为本项目自建（基于 SubConverter-Extended），
                    <strong class="text-slate-400">公益免费提供</strong>，不承诺可用性、稳定性与实时性，请勿滥用。
                    长期使用或对稳定性有要求，建议在「转换」页换成自建后端。
                </div>
                <div>前端与交互参考 SubPilot-Archive 的设计体系。</div>
                <div>转换后端地址、默认目标格式等已移至「转换」页配置。</div>
            </div>
            <div class="flex items-center gap-3 mt-4 pt-4 border-t border-line">
                <div class="text-[11px] text-slate-600 font-mono">
                    {{ auth.token ? `已登录 · ${auth.token.slice(0, 4)}…${auth.token.slice(-4)}` : '未登录' }}
                </div>
                <button class="btn-ghost text-xs ml-auto" @click="logout">退出登录</button>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { api, setToken, auth } from '../stores/auth.js';
import { backend, loadEnv } from '../stores/env.js';
import { THEME_META, THEME_ORDER, themeMode, setTheme } from '../stores/theme.js';
import { NO_AUTOFILL, secretFieldProps } from '../utils/inputs.js';

// API Key 输入框（点击「点击修改」后才渲染）走 v3 密钥框方案：
// text + 圆点伪装，密码管理器根本不认它是凭据字段 —— 见 utils/inputs.js。
const SECRET_FIELD = secretFieldProps();

const router = useRouter();
const message = useMessage();

// 模板表达式有全局白名单，location / window 不在其中 —— 在模板里直接写
// `location.origin` 拿到的是 undefined，渲染时会抛
// "Cannot read properties of undefined (reading 'origin')"。
// 这里先在 setup 作用域取好再给模板用。
const pageOrigin = location.origin;

const settings = ref({});
const saving = ref(false);
const busy = ref(false);
const models = ref([]);
const aiMsg = ref('');
const aiOk = ref(false);
const rotatedAt = ref('');

const cfg = reactive({
    publicBaseUrl: '',
    ai: { baseUrl: '', model: '', apiKey: '' },
});

// ---- 模型下拉 / API Key 的「反密码管理器」状态 ----
// 模型输入框先只读、聚焦才解锁 —— Chrome 对只读字段不弹账号列表。
const modelUnlocked = ref(false);
const modelOpen = ref(false);
// 输入框里的字同时当过滤器：拉到几百个模型时靠它缩小范围
const filteredModels = computed(() => {
    const q = String(cfg.ai.model || '').trim().toLowerCase();
    const list = models.value || [];
    if (!q) return list;
    return list.filter((m) => m.toLowerCase().includes(q));
});

// API Key 输入框默认不渲染（页面上没有裸密码框，Chrome 的登录表单启发式不会启动）。
// 点「点击修改」才出现；点别处且没输入任何内容就收回，别留一个空密码框在页面上。
const keyEditing = ref(false);
const keyInput = ref(null);
function onKeyBlur(e) {
    if (cfg.ai.apiKey) return;
    // 点到「点击修改」那行本身时不收回，否则刚点开就被关掉
    const next = e.relatedTarget;
    if (next && next.closest && next.closest('[data-key-toggle]')) return;
    keyEditing.value = false;
}

// 模型下拉：聚焦模型框即弹出（模板里 @focus 时 modelOpen = true），
// 点外关闭。不用 naive 的 NSelect 是因为它内部还是 native input，
// 照样会触发 Chrome 的账号弹窗；自绘面板要自己管开关。
function onDocClick(e) {
    if (!modelOpen.value) return;
    const box = e.target.closest?.('[data-model-box]');
    if (!box) modelOpen.value = false;
}

function logout() {
    setToken('');
    router.push('/login');
}

async function loadSettings() {
    try {
        const res = await api('/api/settings');
        settings.value = res.data || {};
        cfg.publicBaseUrl = res.data?.publicBaseUrl || '';
        cfg.ai.baseUrl = res.data?.ai?.baseUrl || '';
        cfg.ai.model = res.data?.ai?.model || '';
        cfg.ai.apiKey = '';
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }
}

async function save() {
    saving.value = true;
    try {
        const res = await api('/api/settings', {
            method: 'POST',
            // 只提交本页负责的字段。后端是**部分更新**：未提供的字段保持原值，
            // 所以这里不能带上 subBackend / defaultTarget —— 它们已移到「转换」页，
            // 若跟着提交空值会把那边的设置清掉。
            body: JSON.stringify({
                publicBaseUrl: cfg.publicBaseUrl,
                ai: { baseUrl: cfg.ai.baseUrl, model: cfg.ai.model, apiKey: cfg.ai.apiKey },
            }),
        });
        settings.value = res.data || {};
        cfg.ai.apiKey = '';
        // 保存成功后收回输入框：否则框里空着、旁边也没有圆点，看起来就像
        // 「刚才那次没存上」。收回去立刻变回圆点串，保存生效与否一眼可见。
        keyEditing.value = false;
        message.success('已保存');
        await loadEnv(true);
    } catch (e) {
        message.error(e.message);
    } finally {
        saving.value = false;
    }
}

async function fetchModels() {
    busy.value = true;
    aiMsg.value = '';
    try {
        const res = await api('/ai/models', {
            method: 'POST',
            body: JSON.stringify({
                baseUrl: cfg.ai.baseUrl,
                apiKey: cfg.ai.apiKey || undefined,
            }),
        });
        models.value = res.data || [];
        aiOk.value = true;
        aiMsg.value = `拉到 ${models.value.length} 个模型`;
    } catch (e) {
        aiOk.value = false;
        aiMsg.value = e.message;
    } finally {
        busy.value = false;
    }
}

async function testAi() {
    if (!cfg.ai.baseUrl.trim()) {
        aiOk.value = false;
        aiMsg.value = '请先填写 AI Base URL';
        return;
    }
    busy.value = true;
    aiMsg.value = '';
    try {
        // 模型名还没选时，「探活」改走拉模型列表来验证连通性 ——
        // /models 和 /chat/completions 走同一个 Base URL + Key，
        // 拉得到就说明地址和密钥都没问题，剩下只是选模型的事。
        if (!cfg.ai.model.trim()) {
            const res = await api('/ai/models', {
                method: 'POST',
                body: JSON.stringify({
                    baseUrl: cfg.ai.baseUrl,
                    apiKey: cfg.ai.apiKey || undefined,
                }),
            });
            models.value = res.data || [];
            aiOk.value = true;
            aiMsg.value = `Base URL 连通正常，拉到 ${models.value.length} 个模型 —— 点模型框的 ▾ 选一个后再探活，可测完整链路`;
            return;
        }
        const res = await api('/ai/settings/test', {
            method: 'POST',
            body: JSON.stringify({
                baseUrl: cfg.ai.baseUrl,
                model: cfg.ai.model,
                apiKey: cfg.ai.apiKey || undefined,
            }),
        });
        aiOk.value = true;
        aiMsg.value = `探活成功（${res.data?.ms ?? '?'} ms）`;
    } catch (e) {
        aiOk.value = false;
        aiMsg.value = e.message;
    } finally {
        busy.value = false;
    }
}

async function rotateFeedKey() {
    if (!confirm('轮换后所有已发出的分发链接立即失效，所有客户端都要重新导入。确定继续？')) return;
    busy.value = true;
    try {
        const res = await api('/api/feedkey/rotate', { method: 'POST' });
        rotatedAt.value = res.data?.rotatedAt || new Date().toISOString();
        message.success('已轮换，请重新复制各订阅的分发链接');
    } catch (e) {
        message.error(e.message);
    } finally {
        busy.value = false;
    }
}

onMounted(async () => {
    document.addEventListener('click', onDocClick);
    await loadSettings();
    loadEnv(true);
});
</script>
