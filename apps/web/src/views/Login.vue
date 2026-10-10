<template>
    <div class="min-h-full flex items-center justify-center p-6">
        <div class="card p-8 w-full max-w-sm fade-up">
            <div class="flex items-center gap-3">
                <img
                    src="/logo.svg"
                    alt="SubPilot"
                    class="logo-mark"
                    draggable="false"
                />
                <div>
                    <div class="text-xl font-bold brand-gradient leading-none">SubPilot</div>
                    <div class="text-[11px] text-slate-500 mt-1">AI · SUBSCRIPTION</div>
                </div>
            </div>

            <div v-if="checking" class="mt-6 text-sm text-slate-500">正在检查连接…</div>

            <template v-else>
                <div v-if="devMode" class="mt-6 text-sm text-emerald-300/80">
                    开发调试模式 · 已免鉴权
                </div>
                <div v-else class="mt-6">
                    <label class="text-xs text-slate-500">访问令牌</label>
                    <input
                        v-model="token"
                        v-bind="tokenField"
                        name="sp-access-token"
                        class="input mt-1.5"
                        placeholder="SUBPILOT_TOKEN"
                        :readonly="!unlocked"
                        @focus="unlocked = true"
                        @keyup.enter="submit"
                    />
                    <div v-if="error" class="text-xs text-rose-300/80 mt-2">{{ error }}</div>
                    <button class="btn-primary w-full mt-4" :disabled="busy" @click="submit">
                        {{ busy ? '校验中…' : '进入' }}
                    </button>
                    <div class="text-[11px] text-slate-600 mt-3 leading-relaxed">
                        令牌即部署时设置的 <code class="font-mono">SUBPILOT_TOKEN</code>，
                        存在本机浏览器里，之后免登录。
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { auth, setToken, api } from '../stores/auth.js';
// 令牌已存在 localStorage（登录一次后免登录），不需要浏览器再存一份；
// 密钥框统一走 secretFieldProps()（text + 圆点伪装）：密码管理器根本不认它是
// 凭据字段，账号列表、「保存密码？」气泡统统不会弹 —— 见 utils/inputs.js。
import { secretFieldProps } from '../utils/inputs.js';

const router = useRouter();
const token = ref(auth.token);
const error = ref('');
const busy = ref(false);
const checking = ref(true);
const devMode = ref(false);

// 密钥框的防自动填充属性（含 text-security 圆点伪装，模块加载时算一次即可）
const tokenField = secretFieldProps();
// readonly-until-focus：Chrome 对只读字段不弹任何建议，聚焦时解锁
const unlocked = ref(false);

onMounted(async () => {
    // 已有令牌 → 直接探一下受保护接口，通过就进首页
    if (auth.token) {
        try {
            await api('/api/utils/env');
            router.replace('/');
            return;
        } catch {
            setToken('');
        }
    }
    // 无令牌时探一次：后端若开了开发免鉴权会返回 200，此时静默放行
    try {
        await api('/api/utils/env');
        devMode.value = true;
        setTimeout(() => router.replace('/'), 400);
    } catch {
        /* 正常：需要令牌 */
    } finally {
        checking.value = false;
    }
});

async function submit() {
    error.value = '';
    busy.value = true;
    setToken(token.value.trim());
    try {
        await api('/api/utils/env');
        router.replace('/');
    } catch (e) {
        setToken('');
        error.value = /令牌|401/.test(e.message) ? '令牌不正确' : e.message;
    } finally {
        busy.value = false;
    }
}
</script>
