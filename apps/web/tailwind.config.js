/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{vue,js}'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                // 主题色走 CSS 变量，html.light 切换亮色值（见 styles.css）
                base: 'rgb(var(--c-base) / <alpha-value>)',
                panel: 'rgb(var(--c-panel) / <alpha-value>)',
                panel2: 'rgb(var(--c-panel2) / <alpha-value>)',
                line: 'rgb(var(--c-line) / <alpha-value>)',
                // accent / accent2 同样走变量：此前是硬编码 hex，亮色主题下
                // 紫与亮青沿用暗色原值，在暖浅底上只有 ~3:1，且与压深过的
                // sky 徽标（远程/本地）各唱各的调 —— 蓝色系永远统一不了
                accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
                accent2: 'rgb(var(--accent2-rgb) / <alpha-value>)',
            },
            fontFamily: {
                sans: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
                mono: '"JetBrains Mono", ui-monospace, monospace',
            },
        },
    },
    plugins: [],
};
