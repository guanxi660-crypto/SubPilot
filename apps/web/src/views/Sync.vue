<template>
    <div class="p-6 md:p-10 max-w-4xl mx-auto">
        <div>
            <h1 class="text-2xl font-bold">同步</h1>
            <p class="text-slate-500 text-sm mt-1">
                把订阅 / 组合 / 文件 / 转换后成品备份到 Gist 或 WebDAV，用于跨站点迁移或异地留存
            </p>
        </div>

        <!-- 前提说明 -->
        <div class="card p-5 mt-6 fade-up">
            <div class="text-sm font-semibold">先弄清一件事：什么时候才需要它</div>
            <ul class="text-[11px] text-slate-500 mt-3 space-y-2 list-disc list-inside leading-relaxed">
                <li>
                    <span class="text-slate-300">同一个站点换设备</span>：数据本来就存在本站云端，
                    新设备用<span class="text-amber-300/90">同一个访问令牌</span>登录后数据自动就在，
                    <span class="text-slate-300">不需要</span>这里的同步。
                </li>
                <li>
                    <span class="text-slate-300">迁到另一个站点</span>（例如从公共实例搬到自建，或在两个自建实例之间搬数据）：
                    这时才需要 Gist / WebDAV。两边是各自独立的部署，各有各的访问令牌，数据不会自动过去。
                </li>
                <li>
                    备份里<span class="text-amber-300/90">不含</span>访问令牌，所以恢复<span class="text-slate-300">不要求</span>两端令牌一致 ——
                    但也意味着新站点要用它自己的令牌登录，AI Key 等凭据需要重新填一次。
                </li>
            </ul>
        </div>

        <!-- 通道选择 -->
        <div class="card p-5 mt-4 fade-up" style="--d:50ms">
            <div class="text-sm font-semibold">备份通道</div>
            <div class="flex flex-wrap gap-2 mt-3">
                <button
                    v-for="p in PROVIDERS"
                    :key="p.value"
                    class="btn-ghost !py-1.5 text-xs"
                    :class="cfg.provider === p.value ? '!border-accent/60 !text-accent2' : ''"
                    @click="cfg.provider = p.value"
                >{{ p.label }}</button>
            </div>
            <div class="text-[11px] text-slate-600 mt-2">{{ providerHint }}</div>
        </div>

        <!-- Gist -->
        <div v-if="cfg.provider === 'gist'" class="card p-5 mt-4 fade-up">
            <div class="text-sm font-semibold">GitHub Gist</div>
            <div class="grid sm:grid-cols-2 gap-4 mt-4">
                <div>
                    <label class="text-xs text-slate-500">Personal Access Token</label>
                    <input
                        :value="secretDisplay(cfg.gist.token, sync.gist?.hasToken, 'gist')"
                        @input="cfg.gist.token = $event.target.value"
                        @focus="secretEditing.gist = true"
                        @blur="secretEditing.gist = false"
                        v-bind="SECRET_FIELD"
                        name="sp-gist-token"
                        class="input mt-1.5 font-mono !text-xs"
                        :placeholder="sync.gist?.hasToken ? `已保存（${sync.gist.tokenMask}），留空不修改` : 'ghp_... 需要 gist 权限'"
                    />
                </div>
                <div>
                    <label class="text-xs text-slate-500">Gist ID（留空首次备份自动创建）</label>
                    <input
                        v-model="cfg.gist.gistId"
                        v-bind="NO_AUTOFILL"
                        name="sp-gist-id"
                        class="input mt-1.5 font-mono !text-xs"
                        placeholder="自动创建"
                    />
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mt-5">
                <button class="btn-ghost text-xs" @click="saveCfg">保存配置</button>
                <button class="btn-primary text-xs" :disabled="busy" @click="doGist('backup')">☁ 立即备份</button>
                <button class="btn-ghost text-xs" :disabled="busy" @click="doGist('restore')">⤓ 从云端恢复</button>
                <a
                    v-if="sync.gist?.gistId"
                    :href="`https://gist.github.com/${sync.gist.gistId}`"
                    target="_blank"
                    rel="noreferrer"
                    class="btn-ghost text-xs"
                >查看 Gist ↗</a>
            </div>
            <div class="text-[11px] text-slate-600 mt-3 leading-relaxed">
                备份文件为私密 Gist，文件名 <code>subpilotx-backup.json</code>。
                超过 1MB 时 GitHub API 只给截断内容，本站会自动改走 raw 链接。
            </div>
        </div>

        <!-- WebDAV -->
        <div v-if="cfg.provider === 'webdav'" class="card p-5 mt-4 fade-up">
            <div class="text-sm font-semibold">WebDAV</div>
            <div class="grid sm:grid-cols-2 gap-4 mt-4">
                <div class="sm:col-span-2">
                    <label class="text-xs text-slate-500">服务器地址</label>
                    <input
                        v-model="cfg.webdav.url"
                        v-bind="NO_AUTOFILL"
                        name="sp-webdav-url"
                        class="input mt-1.5 font-mono !text-xs"
                        placeholder="https://dav.jianguoyun.com/dav/"
                    />
                    <div class="text-[11px] text-slate-600 mt-1">
                        必须 https。坚果云填 <code>https://dav.jianguoyun.com/dav/</code>
                    </div>
                </div>
                <div>
                    <label class="text-xs text-slate-500">账号</label>
                    <input
                        v-model="cfg.webdav.user"
                        v-bind="NO_AUTOFILL"
                        name="sp-webdav-user"
                        class="input mt-1.5"
                    />
                </div>
                <div>
                    <label class="text-xs text-slate-500">应用密码</label>
                    <input
                        :value="secretDisplay(cfg.webdav.pass, sync.webdav?.hasPass, 'webdav')"
                        @input="cfg.webdav.pass = $event.target.value"
                        @focus="secretEditing.webdav = true"
                        @blur="secretEditing.webdav = false"
                        v-bind="SECRET_FIELD"
                        name="sp-webdav-pass"
                        class="input mt-1.5"
                        :placeholder="sync.webdav?.hasPass ? `已保存（${sync.webdav.passMask}），留空不修改` : '不是登录密码'"
                    />
                </div>
                <div>
                    <label class="text-xs text-slate-500">目录（可选）</label>
                    <input
                        v-model="cfg.webdav.dir"
                        v-bind="NO_AUTOFILL"
                        name="sp-webdav-dir"
                        class="input mt-1.5 font-mono !text-xs"
                        placeholder="subpilotx"
                    />
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mt-5">
                <button class="btn-ghost text-xs" @click="saveCfg">保存配置</button>
                <button class="btn-ghost text-xs" :disabled="busy" @click="doDav('test')">连接测试</button>
                <button class="btn-primary text-xs" :disabled="busy" @click="doDav('backup')">☁ 立即备份</button>
                <button class="btn-ghost text-xs" :disabled="busy" @click="doDav('restore')">⤓ 从云端恢复</button>
            </div>
            <div class="text-[11px] text-slate-600 mt-3 leading-relaxed">
                安全校验：只允许 https，且拒绝 IP 字面量、内网域名与云元数据地址（防 SSRF）。
            </div>
        </div>

        <!-- 本地文件通道 -->
        <div class="card p-5 mt-4 fade-up" style="--d:100ms">
            <div class="text-sm font-semibold">本地文件</div>
            <div class="text-[11px] text-slate-600 mt-1.5">
                不依赖任何云服务。导出的 JSON 可直接用于「从文件恢复」。
            </div>
            <div class="flex flex-wrap gap-2 mt-4">
                <button class="btn-ghost text-xs" :disabled="busy" @click="exportLocal">⤓ 导出备份</button>
                <label class="btn-ghost text-xs cursor-pointer">
                    ⇧ 从文件恢复
                    <input type="file" accept=".json,application/json" class="hidden" @change="importLocal" />
                </label>
            </div>
        </div>

        <!-- Telegram 推送 -->
        <div class="card p-5 mt-4 fade-up" style="--d:120ms">
            <div class="flex items-center justify-between gap-3 flex-wrap">
                <div class="text-sm font-semibold">Telegram 推送</div>
                <span class="text-[10px] px-2 py-0.5 rounded-full border border-line text-slate-400">
                    把订阅 / 组合 / 文件的链接推到聊天
                </span>
            </div>

            <div class="grid sm:grid-cols-2 gap-4 mt-4">
                <div>
                    <label class="text-xs text-slate-500">
                        Bot Token{{ tgCfg.tokenSet ? '（已配置）' : '' }}
                    </label>
                    <input
                        :value="secretDisplay(tg.token, tgCfg.tokenSet, 'tg')"
                        @input="tg.token = $event.target.value"
                        @focus="secretEditing.tg = true"
                        @blur="secretEditing.tg = false"
                        v-bind="SECRET_FIELD"
                        name="sp-tg-bot-token"
                        class="input mt-1.5 font-mono !text-xs"
                        :placeholder="tgCfg.tokenSet ? `已保存（${tgCfg.tokenMask}），留空不修改` : '123456789:AA...'"
                    />
                    <div class="text-[11px] text-slate-600 mt-1">
                        找 <code>@BotFather</code> 申请。Token 只存服务端，不会回显。
                    </div>
                </div>
                <div>
                    <label class="text-xs text-slate-500">推送 ID（chat_id，可多值）</label>
                    <input
                        v-model="tg.chatIds"
                        v-bind="NO_AUTOFILL"
                        name="sp-tg-chat-ids"
                        class="input mt-1.5 font-mono !text-xs"
                        placeholder="12345678, -1001234567890, @mychannel"
                    />
                    <div class="text-[11px] text-slate-600 mt-1 leading-relaxed">
                        逗号 / 空格分隔，最多 {{ MAX_CHATS }} 个。频道或超级群用 <code>-100</code> 开头的 ID，
                        机器人需先被拉进频道并授予发言权限。
                    </div>
                </div>
            </div>

            <div class="mt-4">
                <div class="flex items-center justify-between">
                    <span class="text-xs text-slate-500">推送目标（可多选）</span>
                    <button
                        v-if="tgPicked.length"
                        class="text-[11px] text-rose-300/80 hover:underline"
                        @click="tgPicked = []"
                    >清空</button>
                </div>

                <div
                    v-if="!tgTargets.length"
                    class="mt-2 text-[11px] text-slate-600 border border-dashed border-line rounded-xl p-3 text-center"
                >
                    还没有订阅 / 组合 / 文件 / 成品，请先去对应页面创建
                </div>

                <!-- 胶囊按钮而不是复选列表：各类目标各自成行、一眼扫完，
                     和转换页「输入源」是同一套交互，用户不用学第二遍。 -->
                <div v-else class="mt-2 space-y-2.5">
                    <template v-for="g in tgGroups" :key="g.kind">
                        <div v-if="g.items.length">
                            <div class="text-[11px] text-slate-600 mb-1.5">{{ g.label }}</div>
                            <div class="flex flex-wrap gap-2">
                                <button
                                    v-for="t in g.items"
                                    :key="t.key"
                                    class="px-3 py-1.5 rounded-xl text-xs border transition max-w-full truncate"
                                    :class="isPicked(t)
                                        ? 'border-accent/60 bg-accent/15 text-white'
                                        : 'border-line bg-panel2 text-slate-400 hover:text-slate-200'"
                                    :title="t.label"
                                    @click="togglePick(t)"
                                >{{ t.emoji }} {{ t.label }}</button>
                            </div>
                        </div>
                    </template>
                </div>

                <div class="text-[11px] text-slate-600 mt-1.5">
                    已选 {{ tgPicked.length }} 项
                    <button class="ml-2 text-slate-500 hover:text-accent2" @click="loadTargets">刷新列表</button>
                </div>
            </div>

            <div class="grid sm:grid-cols-2 gap-4 mt-4">
                <div>
                    <label class="text-xs text-slate-500">推送链接格式</label>
                    <select v-model="tg.linkType" class="input mt-1.5">
                        <option value="">不指定（由转换后端决定）</option>
                        <optgroup v-for="g in targetGroups" :key="g.name" :label="g.name">
                            <option v-for="t in g.items" :key="t.value" :value="t.value">{{ t.label }}</option>
                        </optgroup>
                    </select>
                    <div class="text-[11px] text-slate-600 mt-1">
                        订阅 / 组合的链接会按此格式转换；文件是原样内容，不受影响。
                    </div>
                </div>
                <div>
                    <label class="text-xs text-slate-500">即时推送</label>
                    <label class="flex items-center gap-2 mt-2.5 cursor-pointer">
                        <input v-model="tg.autoPush" type="checkbox" class="accent-accent w-4 h-4" />
                        <span class="text-xs">目标有变动时自动推送</span>
                    </label>
                    <div class="text-[11px] text-slate-600 mt-1 leading-relaxed">
                        只推<strong>上面勾选过</strong>的目标；同一项 15 秒内的连续变动只推一次。
                        推送失败不会影响保存本身。
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 mt-5">
                <button class="btn-ghost text-xs" :disabled="tgBusy" @click="saveTg">保存配置</button>
                <button class="btn-ghost text-xs" :disabled="tgBusy" @click="testTg">
                    {{ tgLoading.test ? '测试中…' : '测试推送' }}
                </button>
                <button
                    class="btn-primary text-xs"
                    :disabled="tgBusy || !tgPicked.length"
                    @click="pushTg()"
                >
                    {{ tgLoading.push ? '推送中…' : '立即推送' }}
                    <span v-if="!tgLoading.push && tgPicked.length"> ({{ tgPicked.length }})</span>
                </button>
            </div>

            <div v-if="tgCfg.lastPush" class="mt-3 text-[11px] leading-relaxed">
                <span :class="tgCfg.lastPush.ok ? 'text-emerald-300/90' : 'text-rose-300/80'">
                    最近推送：{{ tgCfg.lastPush.ok ? '成功' : '失败' }}
                </span>
                <span class="text-slate-600">
                    · {{ fmtTime(tgCfg.lastPush.at) }}
                    · {{ tgCfg.lastPush.sent }} 条消息 / {{ tgCfg.lastPush.chats }} 个聊天
                    / {{ tgCfg.lastPush.targets }} 个目标
                </span>
                <div v-if="tgCfg.lastPush.error" class="text-rose-300/70 mt-1 whitespace-pre-wrap break-all">
                    {{ tgCfg.lastPush.error }}
                </div>
            </div>

            <div class="text-[11px] text-slate-600 mt-3 leading-relaxed">
                推送的链接都是<strong>只读</strong>分发地址（订阅 / 组合带派生密钥，文件带分享码），
                不含管理令牌 —— 所以推进群里也不会把管理权限交出去。
                要整体作废，去「设置」页轮换分发密钥。
            </div>
        </div>

        <!-- 恢复结果 -->
        <div v-if="report" class="card p-5 mt-4 fade-up">
            <div class="text-sm font-semibold">最近一次恢复结果</div>
            <div class="flex gap-2 mt-3 flex-wrap text-[11px]">
                <span class="px-2 py-1 rounded-lg bg-panel2 border border-line">新增 {{ report.added }}</span>
                <span class="px-2 py-1 rounded-lg bg-panel2 border border-line">更新 {{ report.updated }}</span>
                <span class="px-2 py-1 rounded-lg bg-panel2 border border-line">跳过 {{ report.skipped }}</span>
            </div>
            <div v-if="report.warnings?.length" class="mt-3 text-[11px] text-amber-300/90 space-y-1">
                <div v-for="(w, i) in report.warnings" :key="i">⚠ {{ w }}</div>
            </div>
            <div class="text-[11px] text-slate-600 mt-3 leading-relaxed">
                恢复是<strong>合并</strong>而非覆盖：按名称合并，同名以备份为准，本站多余项保留。
            </div>
        </div>

        <!-- 说明 -->
        <div class="card p-5 mt-4 fade-up" style="--d:150ms">
            <div class="text-sm font-semibold">备份里有什么</div>
            <ul class="text-[11px] text-slate-500 mt-3 space-y-1.5 list-disc list-inside leading-relaxed">
                <li>订阅（含 JSON 脚本链）、组合、文件正文、转换后成品快照</li>
                <li><span class="text-amber-300/90">不包含</span>访问令牌、AI Key、同步密码等凭据 —— 避免备份文件变成凭据泄漏渠道</li>
                <li>远程订阅只备份地址，不缓存节点正文（缓存会把过期节点带回来）</li>
                <li>单包上限 20MiB</li>
            </ul>
            <div class="text-[11px] text-slate-600 mt-3 leading-relaxed">
                由于凭据不进备份，在另一站点恢复后需要重新填写 AI Key、Gist Token、网盘密码；
                数据本身（订阅 / 组合 / 文件 / 成品）会完整还原。
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { api } from '../stores/auth.js';
import { loadOperatorMeta, sceTargets } from '../stores/operators.js';
// 本页 3 个密钥框（Gist PAT / WebDAV 应用密码 / TG Bot Token）都是应用自己的密钥，
// 不是站点登录凭据；统一走 secretFieldProps()（text + 圆点伪装），
// 密码管理器根本不认它是凭据字段，账号列表 / 保存密码气泡都不会弹 —— 见 utils/inputs.js。
import { NO_AUTOFILL, secretFieldProps } from '../utils/inputs.js';

// 三个密钥框共用同一份防自动填充属性（text-security 圆点伪装）
const SECRET_FIELD = secretFieldProps();

// ---- 已保存密钥的「圆点占位」----
// 后端只回掩码、不回明文，输入框绑定值一直是空 —— 切页返回后框里就是一片空白，
// 用户看不出「到底存过没有」。这里在「已保存且用户没动过」时把框内填成圆点串
// （输入框本身带 -webkit-text-security: disc，显示的也是圆点），聚焦即清空待输入，
// 失焦仍为空则恢复圆点。提交语义不变：框里是空 = 不修改。
const SECRET_DOTS = '••••••••';
const secretEditing = reactive({ gist: false, webdav: false, tg: false });
function secretDisplay(actual, saved, key) {
    if (actual) return actual;
    return saved && !secretEditing[key] ? SECRET_DOTS : '';
}

const router = useRouter();
const message = useMessage();

const MAX_CHATS = 20;

const PROVIDERS = [
    { value: 'none', label: '不启用' },
    { value: 'gist', label: 'GitHub Gist' },
    { value: 'webdav', label: 'WebDAV' },
];

const sync = ref({});
const busy = ref(false);
const report = ref(null);

const cfg = reactive({
    provider: 'none',
    gist: { token: '', gistId: '' },
    webdav: { url: '', user: '', pass: '', dir: '' },
});

const providerHint = computed(() => {
    if (cfg.provider === 'gist') return 'Gist 适合有 GitHub 账号的用户，免额外服务；私密 Gist 只有你自己可见。';
    if (cfg.provider === 'webdav') return 'WebDAV 适合已有网盘（坚果云等），不依赖 GitHub。';
    return '未启用自动同步，仍可用下方的本地文件通道手动备份。';
});

async function loadConfig() {
    try {
        const res = await api('/api/sync/config');
        sync.value = res.data || {};
        cfg.provider = sync.value.provider || 'none';
        cfg.gist.gistId = sync.value.gist?.gistId || '';
        cfg.webdav.url = sync.value.webdav?.url || '';
        cfg.webdav.user = sync.value.webdav?.user || '';
        cfg.webdav.dir = sync.value.webdav?.dir || '';
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }
}

async function saveCfg() {
    busy.value = true;
    try {
        await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({
                sync: {
                    provider: cfg.provider,
                    gist: { token: cfg.gist.token, gistId: cfg.gist.gistId },
                    webdav: {
                        url: cfg.webdav.url,
                        user: cfg.webdav.user,
                        pass: cfg.webdav.pass,
                        dir: cfg.webdav.dir,
                    },
                },
            }),
        });
        cfg.gist.token = '';
        cfg.webdav.pass = '';
        message.success('配置已保存');
        await loadConfig();
    } catch (e) {
        message.error(e.message);
    } finally {
        busy.value = false;
    }
}

async function doGist(action) {
    busy.value = true;
    try {
        const res = await api(`/api/sync/gist/${action}`, { method: 'POST' });
        if (action === 'backup') {
            message.success(`已备份到 Gist（${res.data?.bytes ?? 0} 字节）`);
            await loadConfig();
        } else {
            report.value = res.data;
            message.success('恢复完成');
        }
    } catch (e) {
        message.error(e.message, { duration: 9000 });
    } finally {
        busy.value = false;
    }
}

async function doDav(action) {
    busy.value = true;
    try {
        const res = await api(`/api/sync/webdav/${action}`, { method: 'POST' });
        if (action === 'test') message.success('连接正常');
        else if (action === 'backup') message.success(`已上传（${res.data?.bytes ?? 0} 字节）`);
        else {
            report.value = res.data;
            message.success('恢复完成');
        }
    } catch (e) {
        message.error(e.message, { duration: 9000 });
    } finally {
        busy.value = false;
    }
}

async function exportLocal() {
    busy.value = true;
    try {
        const res = await api('/api/backup/export');
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `subpilotx-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        message.success('已导出');
    } catch (e) {
        message.error(e.message);
    } finally {
        busy.value = false;
    }
}

async function importLocal(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('导入会与现有数据合并（同名以备份为准），确定继续？')) return;
    busy.value = true;
    try {
        const text = await file.text();
        const res = await api('/api/backup/import', { method: 'POST', body: text });
        report.value = res.data;
        message.success('恢复完成');
    } catch (err) {
        message.error(err.message, { duration: 9000 });
    } finally {
        busy.value = false;
    }
}

// ---------------------------------------------------------------- TG 推送

const tgCfg = ref({});
const tgBusy = ref(false);
const tgLoading = reactive({ test: false, push: false });
const tg = reactive({ token: '', chatIds: '', linkType: '', autoPush: false });
/** 已勾选的目标：[{ kind: 'sub'|'col'|'file'|'converted', name }] */
const tgPicked = ref([]);
const subs = ref([]);
const collections = ref([]);
const files = ref([]);
const converted = ref([]);

/** 推送链接格式的可选项，复用转换页那份 SCE 目标表，不另造一份 */
const targetGroups = computed(() => {
    const map = new Map();
    for (const t of sceTargets.value) {
        const g = t.group || '其它';
        if (!map.has(g)) map.set(g, []);
        map.get(g).push(t);
    }
    const groups = [...map.entries()].map(([name, items]) => ({ name, items }));
    // 库里可能存着已被裁掉的目标格式（见 docs/目标格式体检报告.md）。select 里找不到
    // 对应 option 时浏览器会显示成空白，用户会误以为「没设格式」，但保存时旧值又原样存回去。
    // 所以把当前值显式补一个置顶分组，让它看得见、能改掉。
    const lt = String(tg.linkType || '');
    if (lt && !sceTargets.value.some((t) => t.value === lt)) {
        groups.unshift({ name: '当前格式已下线', items: [{ value: lt, label: `${lt}（已下线）` }] });
    }
    return groups;
});

const tgTargets = computed(() => [
    ...subs.value.map((s) => ({ key: `sub:${s.name}`, kind: 'sub', name: s.name, label: s.displayName || s.name, emoji: '▤' })),
    ...collections.value.map((c) => ({ key: `col:${c.name}`, kind: 'col', name: c.name, label: c.displayName || c.name, emoji: '⊕' })),
    ...files.value.map((f) => ({ key: `file:${f.name}`, kind: 'file', name: f.name, label: f.displayName || f.name, emoji: '⧉' })),
    ...converted.value.map((c) => ({ key: `converted:${c.name}`, kind: 'converted', name: c.name, label: c.name, emoji: '★' })),
]);

/** 按类型分组展示 —— 四类混在一起排，找起来很费劲 */
const tgGroups = computed(() => {
    const LABEL = { sub: '订阅', col: '组合', file: '文件', converted: '成品' };
    return ['sub', 'col', 'file', 'converted'].map((kind) => ({
        kind,
        label: LABEL[kind],
        items: tgTargets.value.filter((t) => t.kind === kind),
    }));
});

function isPicked(t) {
    return tgPicked.value.some((x) => x.kind === t.kind && x.name === t.name);
}

function togglePick(t) {
    const i = tgPicked.value.findIndex((x) => x.kind === t.kind && x.name === t.name);
    if (i >= 0) tgPicked.value.splice(i, 1);
    else tgPicked.value.push({ kind: t.kind, name: t.name });
}

async function loadTg() {
    try {
        const res = await api('/api/telegram/config');
        const d = res.data || {};
        tgCfg.value = d;
        tg.chatIds = d.chatIds || '';
        tg.linkType = d.linkType || '';
        tg.autoPush = !!d.autoPush;
        // 配置里保存的目标可能已被删除，这里用实时列表过滤一遍，
        // 免得界面上出现勾选项但列表里找不到的诡异状态
        tgPicked.value = (d.targets || []).map((x) => ({ kind: x.kind, name: x.name }));
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }
}

/** 拉订阅 / 组合 / 文件 / 成品，供目标列表使用 */
async function loadTargets() {
    try {
        const [s, c, f, cv] = await Promise.all([
            api('/api/subs'),
            api('/api/collections'),
            api('/api/files'),
            api('/api/converted'),
        ]);
        subs.value = s.data || [];
        collections.value = c.data || [];
        files.value = f.data || [];
        converted.value = cv.data || [];
    } catch (e) {
        if (/令牌|401/.test(e.message)) router.push('/login');
    }
}

async function saveTg() {
    tgBusy.value = true;
    try {
        const res = await api('/api/telegram/config', {
            method: 'POST',
            body: JSON.stringify({
                token: tg.token,
                chatIds: tg.chatIds,
                targets: tgPicked.value,
                linkType: tg.linkType,
                autoPush: tg.autoPush,
            }),
        });
        tg.token = '';
        tgCfg.value = res.data || tgCfg.value;
        message.success('TG 推送配置已保存');
    } catch (e) {
        message.error(e.message, { duration: 9000 });
    } finally {
        tgBusy.value = false;
    }
}

async function testTg() {
    tgLoading.test = true;
    try {
        const res = await api('/api/telegram/test', {
            method: 'POST',
            body: JSON.stringify({ token: tg.token, chatIds: tg.chatIds }),
        });
        message.success(`测试消息已发往 ${res.data?.chatId}`);
    } catch (e) {
        message.error(e.message, { duration: 9000 });
    } finally {
        tgLoading.test = false;
    }
}

async function pushTg(targets) {
    tgLoading.push = true;
    try {
        const res = await api('/api/telegram/push', {
            method: 'POST',
            body: JSON.stringify({
                targets: targets || tgPicked.value,
                token: tg.token,
                chatIds: tg.chatIds,
                linkType: tg.linkType,
            }),
        });
        const d = res.data || {};
        const failed = (d.failures || []).length;
        message.success(
            `已推送 ${d.targets} 个目标到 ${d.chats} 个聊天（${d.sent} 条消息）` +
                (failed ? `，${failed} 条失败` : ''),
            { duration: failed ? 9000 : 4000 },
        );
        await loadTg();
    } catch (e) {
        message.error(e.message, { duration: 12000 });
        await loadTg();
    } finally {
        tgLoading.push = false;
    }
}

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

onMounted(async () => {
    await loadConfig();
    await loadTg();
    await loadTargets();
    await loadOperatorMeta();
});
</script>
