<!--
    卡片上的「✈ TG」按钮：把这一项推到 Telegram。

    四处卡片（订阅 / 组合 / 文件 / 成品）共用 —— 逻辑完全一样，只是 kind 不同。
    推送用的是**只读**分发链接（订阅组合走派生密钥，文件成品走分享码），
    所以推到群里也不会泄漏管理令牌。

    「推送设置…」直接跳同步页 —— 批量选择、Bot Token、链接格式都在那边配。
-->
<template>
    <n-dropdown trigger="click" :options="options" @select="onSelect">
        <button
            class="btn-ghost whitespace-nowrap shrink-0"
            :class="compact ? '!py-0.5 !px-2 !text-[11px]' : '!py-1.5 text-xs'"
            :disabled="busy"
            :title="`推送到 Telegram：${label}`"
        >{{ busy ? '推送中…' : '✈ TG' }}</button>
    </n-dropdown>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { NDropdown, useMessage } from 'naive-ui';
import { api } from '../stores/auth.js';

const props = defineProps({
    /** 'sub' | 'col' | 'file' | 'converted' */
    kind: { type: String, required: true },
    name: { type: String, required: true },
    /** 提示语里显示的名字（displayName 优先） */
    label: { type: String, default: '' },
    /** 紧凑尺寸（转换页成品卡的按钮行比订阅/组合卡窄） */
    compact: { type: Boolean, default: false },
});

const router = useRouter();
const message = useMessage();
const busy = ref(false);

const KIND_LABEL = { sub: '订阅', col: '组合', file: '文件', converted: '成品' };

const options = [
    { label: '立即推送', key: 'push' },
    { label: '推送设置…', key: 'settings' },
];

async function onSelect(key) {
    if (key === 'settings') {
        router.push('/sync');
        return;
    }
    busy.value = true;
    try {
        const res = await api('/api/telegram/push', {
            method: 'POST',
            body: JSON.stringify({ targets: [{ kind: props.kind, name: props.name }] }),
        });
        const sent = res.data?.sent ?? 0;
        const chats = res.data?.chats ?? 0;
        message.success(`已推送「${props.label || props.name}」到 ${chats} 个聊天（${sent} 条消息）`);
    } catch (e) {
        // 「还没配 Token / 没填推送 ID」是最常见的失败，直接给一条能点的路，
        // 而不是让人对着「请先填写 TG Bot Token」自己找设置在哪
        const hint = /Token|推送 ID/.test(e.message) ? ' —— 去「同步」页配置' : '';
        message.error(`${KIND_LABEL[props.kind] || ''}推送失败：${e.message}${hint}`, { duration: 9000 });
    } finally {
        busy.value = false;
    }
}
</script>
