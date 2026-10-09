<!--
    生成分享链接的弹窗。文件页与转换页的成品卡共用。

    抽出来的原因很实际：有效期选项、请求体形状、以及「先刷新列表再展开面板」的时序
    （顺序反了会先闪一下「还没有分享链接」）都是容易写错又必须一致的东西。
    各页只负责传目标（type + name）并接住 created 事件。

    弹窗用自绘遮罩而不是 naive 的 NModal：全站弹窗都是这套 Tailwind 卡片，
    混一个 naive 弹窗会在亮色 / 玻璃主题下露出不同的圆角和阴影。
-->
<template>
    <div
        v-if="open"
        class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center overflow-auto py-16 px-4"
        @click.self="$emit('update:open', false)"
    >
        <div class="card w-full max-w-md p-6">
            <div class="font-semibold">为「{{ name }}」生成分享链接</div>
            <div class="text-[11px] text-slate-600 mt-1.5 leading-relaxed">{{ hint }}</div>

            <div class="mt-4">
                <div class="text-xs font-semibold text-slate-400">有效期</div>
                <div class="flex flex-wrap gap-2 mt-2.5">
                    <button
                        v-for="o in SHARE_EXPIRY"
                        :key="o.key"
                        class="btn-ghost !py-1.5 text-xs"
                        :class="kind === o.key ? '!border-accent/60 !text-accent2' : ''"
                        @click="kind = o.key"
                    >{{ o.label }}</button>
                </div>

                <div v-if="kind === 'days'" class="mt-3">
                    <label class="text-xs text-slate-500">天数（≥1）</label>
                    <input v-model.number="days" type="number" min="1" class="input mt-1.5" />
                </div>
                <div v-if="kind === 'date'" class="mt-3">
                    <label class="text-xs text-slate-500">到期日期（当天 23:59:59 失效）</label>
                    <input v-model="date" type="date" class="input mt-1.5" />
                </div>
                <div v-if="kind === 'never'" class="mt-3 text-[11px] text-amber-300/90 leading-relaxed">
                    永久有效意味着这条链接一旦泄露就无法靠过期时间止损，只能手动删除分享码。
                </div>
            </div>

            <div class="flex justify-end gap-2 mt-5">
                <button class="btn-ghost text-xs" @click="$emit('update:open', false)">取消</button>
                <button class="btn-primary text-xs" :disabled="busy" @click="gen">
                    {{ busy ? '生成中…' : '生成' }}
                </button>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { api } from '../stores/auth.js';
import { SHARE_EXPIRY, expiryOptions } from '../utils/share.js';

const props = defineProps({
    open: { type: Boolean, default: false },
    /** 资源名（路径段） */
    name: { type: String, default: '' },
    /** 'file' | 'converted' | 'sub' | 'col' */
    type: { type: String, required: true },
    hint: { type: String, default: '生成后会显示在这张卡片的下方，可直接复制。' },
});

const emit = defineEmits(['update:open', 'created']);

const message = useMessage();
const kind = ref('days7');
const days = ref(30);
const date = ref('');
const busy = ref(false);

// 每次打开都重置成默认值：上次选过「永久有效」，这次再打开还留着，
// 用户很容易在没注意的情况下又发一条不过期的链接。
watch(
    () => props.open,
    (v) => {
        if (!v) return;
        kind.value = 'days7';
        days.value = 30;
        date.value = '';
    },
);

async function gen() {
    const options = expiryOptions(kind.value, days.value, date.value);
    if (!options) return message.error('请选择到期日期');

    busy.value = true;
    try {
        const res = await api('/api/shares', {
            method: 'POST',
            body: JSON.stringify({ type: props.type, name: props.name, options }),
        });
        // 先把新链接交给调用方去刷新列表，再关弹窗 ——
        // 顺序反了会先闪一下「还没有分享链接」
        emit('created', res.data);
        emit('update:open', false);
    } catch (e) {
        message.error(e.message);
    } finally {
        busy.value = false;
    }
}
</script>
