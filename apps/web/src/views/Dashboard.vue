<template>
    <div class="p-6 md:p-10 max-w-6xl mx-auto">
        <div class="flex items-end justify-between gap-4 flex-wrap">
            <div>
                <h1 class="text-2xl font-bold">概览</h1>
                <p class="text-slate-500 text-sm mt-1">
                    订阅 · 脚本处理 · 转换 · 分享，一站管理
                </p>
            </div>
            <button class="btn-ghost !py-1.5 text-xs" :disabled="loading" @click="load">
                {{ loading ? '刷新中…' : '↻ 刷新' }}
            </button>
        </div>

        <!-- 统计卡片 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
            <div
                v-for="(c, i) in cards"
                :key="c.label"
                class="card card-hover p-5 fade-up cursor-pointer"
                :style="`--d:${i * 50}ms`"
                @click="router.push(c.to)"
            >
                <div class="text-[11px] text-slate-500">{{ c.label }}</div>
                <div class="text-3xl font-bold mt-1.5">{{ c.value }}</div>
                <div class="text-[11px] text-slate-600 mt-1">{{ c.hint }}</div>
            </div>
        </div>

        <!-- 后端信息 -->
        <div class="card p-5 mt-4 fade-up" style="--d:200ms">
            <div class="flex items-center gap-3 flex-wrap">
                <span
                    class="w-2 h-2 rounded-full inline-block shrink-0"
                    :class="backend.online ? 'bg-emerald-400' : 'bg-amber-400'"
                ></span>
                <div class="font-medium text-sm">转换后端</div>
                <span class="text-xs font-mono text-slate-400 truncate">{{ backend.subBackend || '未配置' }}</span>
                <span v-if="backend.version" class="type-badge type-default">{{ backend.version }}</span>
                <span v-if="!backend.online" class="text-xs text-amber-300/90">
                    {{ backend.error || '未响应' }}
                </span>
                <div class="ml-auto flex gap-2">
                    <a
                        v-if="backend.subBackend"
                        :href="`${backend.subBackend}/inspect`"
                        target="_blank"
                        rel="noreferrer"
                        class="btn-ghost !py-1.5 text-xs"
                    >诊断台 ↗</a>
                    <button class="btn-ghost !py-1.5 text-xs" @click="router.push('/converter')">配置</button>
                </div>
            </div>
            <div class="text-[11px] text-slate-600 mt-2.5 leading-relaxed">
                本站不自己实现格式转换：订阅存储、JSON 脚本处理与分发在这里完成，格式转换全部交给转换后端。
                转换后端主要面向 mihomo 系列客户端的远程订阅分流转换，其它客户端的基础转换也已覆盖；
                它是开源项目，部分客户端没有实测过，请自行测试。
                <strong>强烈建议自建转换后端</strong>：
                <a
                    href="https://github.com/Aethersailor/SubConverter-Extended"
                    target="_blank"
                    rel="noreferrer"
                    class="text-accent2 hover:underline"
                >SubConverter-Extended</a>
                ，各类免费 PaaS 平台均可部署。
            </div>
            <div class="text-[11px] text-slate-600 mt-2 leading-relaxed">
                注意：<strong class="text-slate-500">Worker 部署版受边缘节点缓存影响，实时预览可能会有延迟</strong>；
                若对实时性要求较高，建议部署 Docker 或 Node.js 版。
            </div>
        </div>

        <!-- 快捷入口的三张列表卡（订阅 / 组合 / 转换后成品）已移除：
             各自都有独立页面，顶部的统计卡与「全部 ›」跳转已经覆盖这个需求，
             概览只保留数字与状态，不做第二份列表 -->

        <!-- 分发统计 -->
        <div class="card p-5 mt-4 fade-up" style="--d:250ms">
            <div class="flex items-center gap-3 flex-wrap">
                <div class="text-sm font-semibold">分发统计</div>
                <div v-if="stats.items.length" class="flex gap-2 text-[11px]">
                    <span class="px-2 py-0.5 rounded-full bg-panel2 border border-line">总拉取 {{ stats.total }}</span>
                    <span class="px-2 py-0.5 rounded-full bg-panel2 border border-line">项目 {{ stats.itemCount }}</span>
                    <span class="px-2 py-0.5 rounded-full bg-panel2 border border-line">独立 IP {{ stats.ipCount }}</span>
                </div>
                <div class="ml-auto flex gap-2">
                    <button
                        v-if="stats.items.length"
                        class="btn-ghost !py-1.5 text-xs"
                        :title="masked ? '显示完整 IP' : '打码显示 IP'"
                        @click="masked = !masked"
                    >{{ masked ? '👁 显示 IP' : '🙈 隐藏 IP' }}</button>
                    <button v-if="stats.items.length" class="btn-ghost !py-1.5 text-xs" @click="exportCsv">⤓ 导出 CSV</button>
                    <button v-if="stats.items.length" class="btn-ghost !py-1.5 text-xs !text-rose-300/80" @click="clearStats">
                        清空
                    </button>
                </div>
            </div>

            <div v-if="stats.items.length" class="mt-4 overflow-x-auto">
                <table class="w-full text-xs">
                    <thead class="text-slate-500">
                        <tr class="text-left">
                            <th class="py-2 font-normal">类型</th>
                            <th class="py-2 font-normal">项目</th>
                            <th class="py-2 font-normal">来源 IP</th>
                            <th class="py-2 font-normal text-right">次数</th>
                            <th class="py-2 font-normal text-right">最近拉取</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(r, i) in stats.items" :key="i" class="border-t border-line">
                            <td class="py-2">
                                <span class="type-badge type-default">{{ r.type }}</span>
                            </td>
                            <td class="py-2 font-mono truncate max-w-[16rem]" :title="r.item">{{ r.item }}</td>
                            <td class="py-2 font-mono">{{ masked ? maskIp(r.ip) : r.ip }}</td>
                            <td class="py-2 text-right">{{ r.count }}</td>
                            <td class="py-2 text-right text-slate-500">{{ fmtTime(r.last) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div v-else class="text-xs text-slate-600 mt-3 leading-relaxed">
                暂无拉取记录 —— 客户端拉取订阅（/download/…）或打开分享链接（/share/…）后，
                这里会显示次数与来源 IP。
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../stores/auth.js';
import { backend, loadEnv } from '../stores/env.js';

const router = useRouter();
const subs = ref([]);
const collections = ref([]);
const converted = ref([]);
const files = ref([]);
const stats = ref({ total: 0, itemCount: 0, ipCount: 0, items: [] });
const loading = ref(false);
const masked = ref(true);

const cards = computed(() => [
    { label: '订阅', value: subs.value.length, hint: '单条订阅', to: '/subs' },
    { label: '组合', value: collections.value.length, hint: '多订阅合并', to: '/collections' },
    { label: '文件', value: files.value.length, hint: '规则 / 模板', to: '/files' },
    { label: '转换后成品', value: converted.value.length, hint: '转换快照', to: '/converter' },
]);

function maskIp(ip) {
    if (!ip) return '';
    if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:****`;
    const p = ip.split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.*.*`;
    return ip;
}

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load() {
    loading.value = true;
    try {
        const [s, c, cv, f] = await Promise.all([
            api('/api/subs'),
            api('/api/collections'),
            api('/api/converted'),
            api('/api/files'),
        ]);
        subs.value = s.data || [];
        collections.value = c.data || [];
        converted.value = cv.data || [];
        files.value = f.data || [];
    } catch (e) {
        if (/令牌|401/.test(e.message)) {
            router.push('/login');
            return;
        }
    }
    // 统计失败静默 —— 它只是锦上添花，不该影响主内容
    try {
        const st = await api('/api/stats');
        stats.value = st.data || stats.value;
    } catch {
        /* ignore */
    }
    loading.value = false;
}

async function clearStats() {
    try {
        await api('/api/stats', { method: 'DELETE' });
        stats.value = { total: 0, itemCount: 0, ipCount: 0, items: [] };
    } catch {
        /* ignore */
    }
}

function exportCsv() {
    const rows = [['类型', '项目', 'IP', '次数', '最近拉取']];
    for (const r of stats.value.items) rows.push([r.type, r.item, r.ip, r.count, r.last]);
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    // 带 BOM，否则 Excel 打开中文会乱码
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `subpilotx-stats-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

onMounted(() => {
    loadEnv(true);
    load();
});
</script>
