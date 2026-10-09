// [SubPilot] 主题状态共享模块
//
// 为什么要抽出来：原先主题逻辑内联在 App.vue 里（themeMode / nextTheme /
// applyThemeClass 都是 setup 局部变量）。设置页要能切换主题，就必须跨组件
// 改同一个状态 —— 把逻辑塞进 provide/inject 或直接操作 App.vue 实例都别扭。
// 抽成模块后 App.vue 与 Settings.vue 引用同一份 ref，任一处切换全局立即生效，
// 且 localStorage 的 key（sp_theme）与初值判定逻辑只有一份实现，
// 不会出现两处判断不一致导致的主题回跳。
//
// 三个主题：
//   glass —— 玻璃（深色调，默认）
//   light —— 亮色
//   dark  —— 暗色（纯黑基调）
//
// localStorage key = 'sp_theme'
//   存在 → 用户选定的三档之一，固定该主题
//   不存在 → 首次访问时按系统偏好定初值（浅色 → light，深色 → glass），
//            之后不再跟随系统变化

import { ref, computed } from 'vue';

/** 主题元数据：下拉选项与提示文案共用，避免两处各写一份 */
export const THEME_META = {
    glass: { name: '玻璃', icon: '❍' },
    light: { name: '亮色', icon: '☀' },
    dark: { name: '暗色', icon: '☾' },
};

/** 轮转顺序（侧栏那颗切换按钮按此序循环） */
export const THEME_ORDER = ['glass', 'light', 'dark'];

const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

/**
 * 首次访问时的初值：按系统偏好挑一档。
 * 注意仅用于「localStorage 尚无 sp_theme」的那一次，之后不再重算 ——
 * 三档固定，没有跟随系统。
 */
function systemTheme() {
    return prefersLight.matches ? 'light' : 'glass';
}

function initTheme() {
    const stored = localStorage.getItem('sp_theme');
    // 非法值（如旧版本遗留、手改 localStorage）一律回退到系统判定，
    // 不能直接return stored —— 那会让 <html> 上的主题 class 与实际不符。
    if (stored && THEME_ORDER.includes(stored)) return stored;
    return systemTheme();
}

/** 全局唯一的主题状态。模块级 ref → 天然单例 */
export const themeMode = ref(initTheme());

/** 下一个主题（轮转用） */
export const nextTheme = computed(
    () => THEME_ORDER[(THEME_ORDER.indexOf(themeMode.value) + 1) % THEME_ORDER.length],
);

/** 主题对应的显示名，供设置页下拉回显 */
export const themeName = computed(() => THEME_META[themeMode.value]?.name || themeMode.value);

/** 把主题写到 <html> 的 class 上，CSS 靠它切换配色变量 */
export function applyThemeClass(mode) {
    const el = document.documentElement;
    // 三档都要 toggle。漏掉任何一档，选中它时 <html> 上就没有主题 class，
    // 页面会静默落回 :root 的默认（浅色）变量 —— 表现为「切了没反应」，
    // 而且因为其余两档被正确移除，还会顺手把上一个主题的样式也抹掉。
    el.classList.toggle('light', mode === 'light');
    el.classList.toggle('glass', mode === 'glass');
    el.classList.toggle('dark', mode === 'dark');
}

/**
 * 切换到指定主题，并记住选择。
 *
 * 三档固定，不再有「跟随系统」：localStorage 里没有 sp_theme 时
 * 只在**首次访问**按系统偏好定一个初值（系统浅色 → light，深色 → glass），
 * 之后用户选过就一直是那个选择，不会再被系统变更影响。
 *
 * @param {string} mode  'glass' | 'light' | 'dark'
 * @returns {boolean}   是否切换成功（非法值返回 false）
 */
export function setTheme(mode) {
    if (!THEME_ORDER.includes(mode)) return false;
    localStorage.setItem('sp_theme', mode);
    themeMode.value = mode;
    applyThemeClass(mode);
    return true;
}

/** 轮转到下一个主题（侧栏那颗按钮用；等价于 setTheme(nextTheme)） */
export function cycleTheme() {
    return setTheme(nextTheme.value);
}

