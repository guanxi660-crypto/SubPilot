<template>
    <div ref="host" class="code-editor"></div>
</template>

<script setup>
// 带行号的纯文本编辑器（节点内容 / URI 列表 / Clash YAML）。
//
// 行号默认按物理行；订阅内容编辑器传 node-numbers 后改为「一个节点一个行号」：
// URI 一行一节点、YAML 只在 `- name:` 行显示节点序号，节点内部字段行留空 ——
// 这样在一个节点里插字段不会让后面所有节点的号漂移。远程订阅地址是 URL 列表，
// 不是节点，保持物理行号。
//
// 与参考实现（SubPilot-Archive 的 NodeContentEditor）的差别：
//   那边把颜色写死在 EditorView.theme 里；本站有 dark / light / glass 三套主题，
//   写死就没法跟随。这里颜色一律引用 styles.css 的 --cm-* 变量 ——
//   变量在绘制时求值，所以切换主题不需要重建编辑器实例。
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { EditorView, lineNumbers, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { buildNodeNumberMap } from '../utils/nodeLineNumbers.js';

const props = defineProps({
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    /** 只读（用于「预览」之类的展示场景） */
    readonly: { type: Boolean, default: false },
    /** true：行号 = 节点序号（一个节点一个号）；false：普通物理行号 */
    nodeNumbers: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const host = ref(null);
let view = null;

// 行号 = 节点序号（一个节点一个号），见 utils/nodeLineNumbers.js。
// formatNumber 由 CodeMirror 按可见行调用；弱键缓存避免每次滚动都全量重扫。
const numberMaps = new WeakMap();
function formatNodeNumber(lineNo, state) {
    if (!props.nodeNumbers) return String(lineNo);
    let map = numberMaps.get(state);
    if (!map) {
        map = buildNodeNumberMap(state.doc);
        numberMaps.set(state, map);
    }
    return map.get(lineNo) || '';
}

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
            lineNumbers({ formatNumber: formatNodeNumber }),
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
