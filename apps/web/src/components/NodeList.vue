<template>
    <div v-if="nodes.length" class="space-y-1 font-mono text-xs">
        <div
            v-for="n in nodes"
            :key="n.id"
            class="flex items-center gap-2 bg-panel2 rounded-lg px-3 py-2"
        >
            <span :class="['type-badge shrink-0', typeCls(n.type)]">{{ n.type }}</span>
            <span class="text-slate-300 truncate">{{ n.name }}</span>
        </div>
    </div>
    <div v-else class="text-xs text-slate-600 py-6 text-center">没有解析出节点</div>
</template>

<script setup>
const props = defineProps({
    nodes: { type: Array, default: () => [] },
});

const TYPED = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hysteria', 'tuic', 'wireguard', 'anytls'];
const typeCls = (t) => (TYPED.includes(String(t).toLowerCase()) ? `type-${String(t).toLowerCase()}` : 'type-default');
</script>
