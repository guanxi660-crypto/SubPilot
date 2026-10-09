<template>
    <div ref="host" class="code-editor"></div>
</template>

<script setup>
// 带行号的纯文本编辑器（节点内容 / URI 列表 / Clash YAML）。
//
// 为什么用 CodeMirror 而不是 <textarea>：
//   行号是这里的主要诉求 —— 节点内容动辄几十上百行，报错说「第 12 行」时
//   textarea 完全帮不上忙。手搓一个行号槽（左侧 div 跟滚动同步）在折行场景
//   必然错位，CodeMirror 的 lineNumbers 按逻辑行编号、折行不额外计数，
//   行号格子高度自动撑到折行后的总高度，不用自己算。
//
// 与参考实现（SubPilot-Archive 的 NodeContentEditor）的差别：
//   那边把颜色写死在 EditorView.theme 里；本站有 dark / light / glass 三套主题，
//   写死就没法跟随。这里颜色一律引用 styles.css 的 --cm-* 变量 ——
//   变量在绘制时求值，所以切换主题不需要重建编辑器实例。
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { EditorView, lineNumbers, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

const props = defineProps({
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    /** 只读（用于「预览」之类的展示场景） */
    readonly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const host = ref(null);
let view = null;

const theme = EditorView.theme(
    {
        '&': {
            height: '100%',
            fontSize: '12px',
            color: 'var(--cm-text)',
            backgroundColor: 'transparent',
        },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
            fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
            lineHeight: '1.5rem',
            overflow: 'auto',
        },
        '.cm-content': { padding: '8px 0', caretColor: 'var(--cm-caret)' },
        '.cm-line': { padding: '0 12px' },
        '.cm-gutters': {
            backgroundColor: 'var(--cm-gutter-bg)',
            border: 'none',
            borderRight: '1px solid var(--cm-gutter-border)',
            color: 'var(--cm-gutter-fg)',
            userSelect: 'none',
        },
        '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '2.25rem' },
        '.cm-placeholder': { color: 'var(--cm-placeholder)' },
        '.cm-activeLine': { backgroundColor: 'transparent' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cm-caret)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
            backgroundColor: 'var(--cm-selection)',
        },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-caret)' },
    },
    { dark: true },
);

onMounted(() => {
    view = new EditorView({
        doc: props.modelValue,
        parent: host.value,
        extensions: [
            lineNumbers(),
            EditorView.lineWrapping,
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            cmPlaceholder(props.placeholder),
            EditorState.readOnly.of(props.readonly),
            EditorView.editable.of(!props.readonly),
            theme,
            EditorView.updateListener.of((u) => {
                if (u.docChanged) emit('update:modelValue', u.state.doc.toString());
            }),
        ],
    });
});

// 外部值变化（载入订阅数据、套用模板）时同步进来。
// 必须比对后再 dispatch，否则自己触发的 emit 会被回灌成一次光标跳动。
watch(
    () => props.modelValue,
    (v) => {
        if (!view) return;
        const cur = view.state.doc.toString();
        if (v !== cur) {
            view.dispatch({ changes: { from: 0, to: cur.length, insert: v ?? '' } });
        }
    },
);

onBeforeUnmount(() => {
    view?.destroy();
    view = null;
});
</script>
