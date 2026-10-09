// 全局后端环境信息：转换后端（SubConverter-Extended）身份 + 本站版本。
//
// 为什么抽成模块：侧栏状态点、概览页、转换页、设置页都要用同一份数据，
// 各页各拉一次既浪费又会不一致（比如改了 SCE 地址后侧栏还是旧值）。
//
// 令牌未配置 / 401 时静默降级为「未连接」，不弹错 —— 这是常态，不是异常。

import { reactive, computed } from 'vue';
import { api } from './auth.js';

export const backend = reactive({
    loaded: false,
    online: false,
    /** SubConverter-Extended 的 /version 摘要 */
    version: '',
    /** 本站 Worker 版本 */
    appVersion: '',
    /** 当前使用的转换后端地址 */
    subBackend: '',
    /** 后端声明的能力标签 */
    feature: [],
    error: '',
});

export const backendLabel = computed(() => {
    if (!backend.loaded) return '连接中…';
    // 后端异常时先讲状态 —— 这比版本号有用得多
    if (!backend.online) return backend.subBackend ? '后端未响应' : '未配置';
    // 正常时显示**本站**版本。此前这里返回的是 `SCE <后端版本>`，
    // 用户看到「SCE v1.9.13」会以为 1.9.13 是本站的版本号 ——
    // 转换后端的版本另有去处（概览页的后端卡片里，与后端地址一起显示）。
    return backend.appVersion ? `subpilot v ${backend.appVersion}` : 'subpilot';
});

export async function loadEnv(force = false) {
    if (backend.loaded && !force) return backend;
    try {
        const res = await api('/api/utils/env');
        const d = res.data || {};
        backend.online = !!d.online;
        backend.version = d.sceVersion || '';
        backend.appVersion = d.version || '';
        backend.subBackend = d.subBackend || '';
        backend.feature = d.feature || [];
        backend.error = d.error || '';
    } catch (e) {
        backend.online = false;
        backend.error = e.message;
    } finally {
        backend.loaded = true;
    }
    return backend;
}
