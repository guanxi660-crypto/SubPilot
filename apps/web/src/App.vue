<template>
    <n-config-provider :theme="naiveTheme" :theme-overrides="overrides" class="h-full">
        <n-message-provider placement="top">
            <n-dialog-provider>
                <!-- h-screen：不依赖父级高度链，侧边栏/内容区高度恒等于视口 -->
                <div class="h-screen w-full max-w-full flex overflow-hidden">
                    <!-- 侧边栏（桌面） -->
                    <aside
                        class="w-60 min-w-[15rem] max-w-[15rem] shrink-0 grow-0 hidden md:flex flex-col border-r border-line bg-panel/40 backdrop-blur"
                    >
                        <div class="px-6 pt-7 pb-6 flex items-center gap-3">
                            <img
                                src="/logo.svg"
                                alt="SubPilot"
                                class="logo-mark"
                                draggable="false"
                            />
                            <div>
                                <div class="text-xl font-bold brand-gradient leading-none">
                                    SubPilot
                                </div>
                                <div class="text-[11px] text-slate-500 mt-1 tracking-wider">
                                    AI · SUBSCRIPTION
                                </div>
                            </div>
                        </div>

                        <nav class="flex-1 px-3 space-y-1 mt-2 overflow-y-auto">
                            <router-link
                                v-for="item in nav"
                                :key="item.to"
                                :to="item.to"
                                class="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all border border-transparent"
                                active-class="!border-accent/30 bg-accent/15 text-white shadow-sm"
                                :class="'text-slate-400 hover:text-slate-200 hover:bg-panel2'"
                            >
                                <span class="text-base w-5 text-center opacity-80">{{ item.icon }}</span>
                                {{ item.label }}
                            </router-link>
                        </nav>

                        <div class="px-6 py-5 text-[11px] text-slate-600">
                            <div class="flex items-center gap-2">
                                <span
                                    class="w-1.5 h-1.5 rounded-full inline-block"
                                    :class="backend.online ? 'bg-emerald-400' : 'bg-amber-400'"
                                    :title="backend.online ? '转换后端在线' : '转换后端未知'"
                                ></span>
                                <span class="truncate" :title="backendLabel">{{ backendLabel }}</span>
                                <button
                                    class="ml-auto w-[26px] h-[26px] rounded-lg bg-gradient-to-br from-accent to-accent2 text-white text-xs shadow-md shadow-accent/35 hover:brightness-110 hover:scale-105 active:scale-95 transition flex items-center justify-center shrink-0"
                                    :title="`主题：${THEME_META[themeMode].name} · 点击切换到${THEME_META[nextTheme].name}`"
                                    @click="toggleTheme"
                                >
                                    {{ THEME_META[themeMode].icon }}
                                </button>
                            </div>
                            <!-- 前端构建指纹。SPA 常驻不会自动更新，部署后旧页面依旧能跑，
                                 于是「改了没生效」十有八九是手上这份是旧的。这行让版本可自查：
                                 和最新部署的 build 号不一致 → Ctrl+Shift+R 硬刷新。 -->
                            <div
                                class="mt-1.5 font-mono text-[10px] text-slate-700 truncate"
                                :title="`前端构建 ${BUILD_TIME}（${BUILD_ID}）· 与最新部署不一致时请硬刷新`"
                            >
                                build {{ BUILD_ID }}
                            </div>
                        </div>
                    </aside>

                    <div class="flex-1 flex flex-col min-w-0 pb-14 md:pb-0">
                        <!-- 移动端顶栏 -->
                        <header
                            class="md:hidden flex items-center gap-3 px-4 py-3 border-b border-line bg-panel/60 backdrop-blur sticky top-0 z-40"
                        >
                            <img
                                src="/logo.svg"
                                alt="SubPilot"
                                class="logo-mark !w-7 !h-7"
                                draggable="false"
                            />
                            <span class="font-bold brand-gradient">SubPilot</span>
                        </header>

                        <main class="flex-1 overflow-auto">
                            <router-view v-slot="{ Component }">
                                <transition name="page" mode="out-in">
                                    <component :is="Component" />
                                </transition>
                            </router-view>
                        </main>
                    </div>
                </div>

                <!-- 移动端底部导航：条目较多，横向可滚动 -->
                <nav
                    class="md:hidden fixed bottom-0 inset-x-0 z-40 flex border-t border-line bg-panel/90 backdrop-blur overflow-x-auto"
                >
                    <router-link
                        v-for="item in nav"
                        :key="item.to"
                        :to="item.to"
                        class="flex-1 min-w-[62px] flex flex-col items-center gap-0.5 py-2 text-[10px] shrink-0"
                        active-class="text-accent2"
                        :class="'text-slate-500'"
                    >
                        <span class="text-base">{{ item.icon }}</span>
                        {{ item.label }}
                    </router-link>
                </nav>
            </n-dialog-provider>
        </n-message-provider>
    </n-config-provider>
</template>

<script setup>
/* global __BUILD_ID__, __BUILD_TIME__ */
import { computed, onMounted } from 'vue';

// 构建期由 vite.config.js 的 define 注入（编译时常量，不是运行时变量）
const BUILD_ID = __BUILD_ID__;
const BUILD_TIME = __BUILD_TIME__;

import {
    THEME_META,
    themeMode,
    nextTheme,
    cycleTheme,
    applyThemeClass,
} from './stores/theme.js';
import { backend, loadEnv, backendLabel } from './stores/env.js';

import { lightTheme, darkTheme } from 'naive-ui';
// naive-ui 组件必须显式 import，否则模板编译成 _resolveComponent('n-message-provider')
// 运行时查不到名字 → provider 不 provide → useMessage()/useDialog() 直接抛错。
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui';

const naiveTheme = computed(() => (themeMode.value === 'light' ? lightTheme : darkTheme));

const overrides = computed(() => ({
    common: {
        primaryColor: '#7c6cff',
        primaryColorHover: '#8d7fff',
        primaryColorPressed: '#6a59f0',
        bodyColor: 'transparent',
        ...(themeMode.value === 'light'
            ? {
                  cardColor: '#ffffff',
                  modalColor: '#ffffff',
                  popoverColor: '#ffffff',
                  // naive-ui 主色与页面 accent 同步压深：原来沿用 #7c6cff，
                  // 下拉选中项等亮色高亮在浅底上偏淡
                  primaryColor: '#584ad6',
                  primaryColorHover: '#6a5ce6',
                  primaryColorPressed: '#4a3cc4',
              }
            : themeMode.value === 'glass'
              ? {
                    cardColor: 'rgba(255, 255, 255, 0.1)',
                    modalColor: 'rgba(28, 24, 52, 0.95)',
                    popoverColor: 'rgba(28, 24, 52, 0.95)',
                }
              : {
                    cardColor: '#12121c',
                    modalColor: '#181826',
                    popoverColor: '#181826',
                }),
    },
}));

function toggleTheme() {
    cycleTheme();
}

onMounted(() => {
    applyThemeClass(themeMode.value);
    // 后端信息是全局的（侧栏状态点 + 概览页 + 设置页都要），在壳层拉一次
    loadEnv();
});

const nav = [
    { to: '/', label: '概览', icon: '◉' },
    { to: '/subs', label: '订阅', icon: '▤' },
    { to: '/collections', label: '组合', icon: '⊕' },
    { to: '/files', label: '文件', icon: '▦' },
    { to: '/converter', label: '转换', icon: '⇄' },
    { to: '/sync', label: '同步', icon: '⇅' },
    { to: '/ai', label: 'AI', icon: '✦' },
    { to: '/settings', label: '设置', icon: '⚙' },
];
</script>
