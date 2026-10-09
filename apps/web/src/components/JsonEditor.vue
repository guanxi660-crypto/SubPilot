<template>
    <div>
        <div class="flex items-center gap-2 mb-1.5">
            <span v-if="label" class="text-xs text-slate-500">{{ label }}</span>
            <span v-if="error" class="text-xs text-rose-300 truncate" :title="error">
                ✕ {{ error }}
            </span>
            <span v-else-if="dirty" class="text-xs text-emerald-300/80">JSON 合法</span>
            <div class="ml-auto flex gap-1 shrink-0">
                <button class="btn-ghost !py-0.5 !px-2 !text-[11px]" @click="format">格式化</button>
                <button class="btn-ghost !py-0.5 !px-2 !text-[11px]" @click="compact">压缩</button>
                <slot name="actions" />
            </div>
        </div>
        <textarea
            ref="el"
            class="input font-mono !text-xs leading-relaxed resize-y"
            :rows="rows"
            :placeholder="placeholder"
            :value="modelValue"
            spellcheck="false"
            @input="onInput"
        ></textarea>
    </div>
</template>

<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
    modelValue: { type: String, default: '' },
    label: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    rows: { type: Number, default: 8 },
    /** 传 'json' 时做语法校验 */
    validate: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'valid']);

const el = ref(null);
const error = ref('');
const dirty = ref(false);

function check(text) {
    if (props.validate !== 'json') {
        error.value = '';
        return true;
    }
    const t = String(text || '').trim();
    if (!t) {
        error.value = '';
        return true;
    }
    try {
        JSON.parse(t);
        error.value = '';
        return true;
    } catch (e) {
        // 只取第一行，JSON 报错信息常常很长
        error.value = String(e.message || e).split('\n')[0];
        return false;
    }
}

function onInput(e) {
    const v = e.target.value;
    dirty.value = true;
    check(v);
    emit('update:modelValue', v);
    emit('valid', !error.value);
}

watch(
    () => props.modelValue,
    (v) => check(v),
    { immediate: true },
);

function transform(fn) {
    const t = String(props.modelValue || '').trim();
    if (!t) return;
    try {
        const parsed = JSON.parse(t);
        const next = fn(parsed);
        emit('update:modelValue', next);
        check(next);
    } catch (e) {
        error.value = String(e.message || e).split('\n')[0];
    }
}

const format = () => transform((o) => JSON.stringify(o, null, 2));
const compact = () => transform((o) => JSON.stringify(o));

defineExpose({ focus: () => el.value?.focus() });
</script>
