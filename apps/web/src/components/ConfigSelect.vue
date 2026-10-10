<!--
    远程配置（模板）选择器 —— 与 SubPilot-Archive 的交互保持一致：
    默认 / 自定义地址… / 按来源分组的预设 / 不套模板。

    对外只收发**真实 URL 字符串**（'' 表示不套模板），
    这样父组件把它直接塞进 config= 参数即可，不需要关心下拉框的内部取值。
-->
<template>
    <div>
        <select :value="sel" class="input mt-1.5" @change="onChange">
            <option value="__default">默认（Custom_Clash 默认版）</option>
            <option value="__custom">自定义地址…</option>
            <optgroup v-for="g in CONFIG_PRESET_GROUPS" :key="g.label" :label="g.label">
                <option v-for="p in g.options" :key="p.url" :value="p.url">{{ p.name }}</option>
            </optgroup>
            <option value="__none">不套模板（仅节点 + 简单分组）</option>
        </select>

        <!-- 自定义：输入框里直接就是当前地址，可以在预设基础上改，不用重新敲一遍 -->
        <div v-if="sel === '__custom'" class="mt-2 space-y-2">
            <input
                :value="modelValue"
                class="input font-mono !text-xs"
                placeholder="https://.../Custom_Clash.ini"
                spellcheck="false"
                @input="emit('update:modelValue', $event.target.value)"
            />
            <div class="flex flex-wrap items-center gap-2">
                <button
                    class="btn-ghost !py-1 text-xs"
                    :disabled="!modelValue.trim() || saved.includes(modelValue.trim())"
                    @click="remember"
                >记住这个地址</button>
                <span class="text-[11px] text-slate-600">记住后下次直接从下面选</span>
            </div>
            <div v-if="saved.length" class="flex flex-wrap gap-1.5">
                <span
                    v-for="c in saved"
                    :key="c"
                    class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition"
                    :class="c === modelValue.trim()
                        ? 'border-accent/60 bg-accent/15 text-white'
                        : 'border-line bg-panel2 text-slate-300'"
                >
                    <button class="hover:text-white max-w-[240px] truncate" :title="c" @click="emit('update:modelValue', c)">
                        {{ shortName(c) }}
                    </button>
                    <button class="text-rose-300/70 hover:text-rose-300" title="删除" @click="forget(c)">✕</button>
                </span>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import {
    CONFIG_PRESET_GROUPS,
    DEFAULT_CONFIG_URL,
    PRESET_NAME_BY_URL,
    writeLastConfig,
} from '../utils/configPresets.js';

const props = defineProps({
    modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const STORE_KEY = 'sp_conv_config_list';

function read() {
    try {
        const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
    } catch {
        return [];
    }
}
const saved = ref(read());

function write(list) {
    saved.value = list;
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
        /* 隐私模式写不进去也不影响使用 */
    }
}

// 下拉框的选中项。customMode 单独用一个标记：
// 否则点「自定义地址…」后值仍是旧地址，会被判定回预设项，输入框立刻消失。
const customMode = ref(false);

const sel = computed(() => {
    if (customMode.value) return '__custom';
    const v = (props.modelValue || '').trim();
    if (!v) return '__none';
    if (v === DEFAULT_CONFIG_URL) return '__default';
    if (PRESET_NAME_BY_URL[v]) return v;
    return '__custom'; // 外部传进来的任意地址，按自定义处理
});

// 值一旦回到「空 / 默认 / 某个预设」，就退出自定义模式
watch(
    () => props.modelValue,
    (v) => {
        const t = (v || '').trim();
        if (t === '' || t === DEFAULT_CONFIG_URL || PRESET_NAME_BY_URL[t]) customMode.value = false;
        // 顺手记下这次用的地址：下次进转换页直接拿它当初值，不用再挑一遍。
        // 空值（不套模板）不写入 —— 见 configPresets.js 里那段说明。
        writeLastConfig(t);
    },
);

function onChange(e) {
    const v = e.target.value;
    if (v === '__custom') {
        // 不动值：输入框里保留当前地址，方便在原预设基础上微调
        customMode.value = true;
        return;
    }
    customMode.value = false;
    if (v === '__default') emit('update:modelValue', DEFAULT_CONFIG_URL);
    else if (v === '__none') emit('update:modelValue', '');
    else emit('update:modelValue', v);
}

function remember() {
    const v = props.modelValue.trim();
    if (!v || saved.value.includes(v)) return;
    write([...saved.value, v]);
}

function forget(url) {
    write(saved.value.filter((x) => x !== url));
}

/** 长地址在 chip 上只留尾部，鼠标悬停看全文 */
function shortName(url) {
    try {
        const u = new URL(url);
        const file = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
        return `${u.hostname.replace(/^www\./, '')}/${file}`;
    } catch {
        return url.length > 40 ? `…${url.slice(-38)}` : url;
    }
}
</script>
