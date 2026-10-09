<!--
    卡片下方就地展开的分享链接列表（文件页 / 转换页成品卡共用）。
    父组件负责「展开哪一张」和刷新数据，这里只管展示 + 复制 + 请求删除。
-->
<template>
    <div class="space-y-1.5">
        <div v-if="!shares.length" class="text-[11px] text-slate-600 leading-relaxed">
            还没有分享链接 —— 点上面的「生成链接」创建一个。
        </div>
        <div
            v-for="s in shares"
            :key="s.code"
            class="text-[11px] bg-panel2 rounded-lg px-2.5 py-2"
        >
            <div class="font-mono break-all text-slate-400">{{ shareUrl(s) }}</div>
            <div class="flex items-center gap-2 mt-1.5">
                <span class="text-slate-600">{{ s.expiresAt ? `至 ${fmtDate(s.expiresAt)}` : '永久有效' }}</span>
                <div class="ml-auto flex gap-1.5">
                    <button class="btn-ghost !py-0.5 !px-2 !text-[11px]" @click="copy(s)">复制</button>
                    <button
                        class="btn-ghost !py-0.5 !px-2 !text-[11px] !text-rose-300/80"
                        @click="$emit('delete', s)"
                    >删除</button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { useMessage } from 'naive-ui';
import { shareUrl, fmtDate } from '../utils/share.js';

defineProps({
    shares: { type: Array, default: () => [] },
});
defineEmits(['delete']);

const message = useMessage();

function copy(s) {
    navigator.clipboard.writeText(shareUrl(s));
    message.success('已复制');
}
</script>
