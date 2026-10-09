<template>
    <div class="fade-up flex flex-col items-center justify-center text-center py-14 px-6">
        <div
            class="w-14 h-14 rounded-2xl border border-line bg-panel2 flex items-center justify-center text-2xl mb-4 opacity-70"
        >
            {{ icon }}
        </div>
        <div class="text-sm text-slate-400 font-medium">{{ title }}</div>
        <div v-if="hint" class="text-xs text-slate-600 mt-1.5 max-w-xs">{{ hint }}</div>
        <slot />
    </div>
</template>

<script setup>
defineProps({
    icon: { type: String, default: '◌' },
    title: { type: String, default: '这里空空如也' },
    hint: { type: String, default: '' },
});
</script>
