import { reactive } from 'vue';

// 访问令牌（SUBPILOT_TOKEN），存 localStorage。
// key 前缀统一用 sp_（SubPilot）—— 全站 localStorage key 共用一个命名空间，
// 另见 stores/theme.js（sp_theme）、views/Subs.vue（sp_subs_cols）、
// views/AIAssistant.vue（sp_sessions: / sp_chat_last）。
export const auth = reactive({
    token: localStorage.getItem('sp_token') || '',
    get configured() {
        return !!this.token;
    },
});

export function setToken(t) {
    auth.token = t || '';
    if (t) localStorage.setItem('sp_token', t);
    else localStorage.removeItem('sp_token');
}

/** 令牌错误判定：401 与后端返回的令牌相关文案都算 */
export function isAuthError(msg) {
    return /401|令牌|未授权|unauthorized/i.test(String(msg || ''));
}

/**
 * 统一 API 请求：自动附带 Bearer token。
 *
 * 后端在写操作后返回**最新快照**（见 server/src/storage.js 的说明），
 * 所以调用方可以直接用返回的 data 覆盖本地状态，不必再发一次读请求。
 */
export async function api(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401) {
        throw new Error('需要访问令牌（SUBPILOT_TOKEN）');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'failed') {
        const base = data.message || data.error?.message || `HTTP ${res.status}`;
        const details = data.error?.details || data.details;
        throw new Error(details ? `${base}\n${details}` : base);
    }
    return data;
}
