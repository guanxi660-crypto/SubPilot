/**
 * 编辑器的「节点行号」映射：物理行 -> 节点序号。
 *
 * 规则（一个节点一个行号）：
 * - URI 分享链接（scheme://...）：一行就是一个节点，该行显示递增序号
 * - Clash YAML：只有节点条目起始行（`- name: xxx`）显示序号，
 *   该节点的 type/server/port/... 等字段行留空 —— 插入字段不会让后面的节点号漂移
 * - proxy-groups / rules 等非节点段里的 `- name:` 不计入
 * - 混贴内容按出现顺序统一编号
 */

const NODE_URI = /^\s*[a-z][a-z0-9+.-]*:\/\//i;
const TOP_KEY = /^([A-Za-z][\w-]*)\s*:(?!\/\/)/;
const YAML_NODE_START = /^\s*-\s+['"]?name['"]?\s*:/; // `name` 也可写成 'name' / "name"
const NODE_SECTIONS = new Set(['', 'proxies', 'proxy']);

/**
 * @param {{ lines: number, line(n: number): { text: string } }} doc CodeMirror 的 Text 文档（或等价只读结构）
 * @returns {Map<number, string>} 物理行号 -> 显示在该行的节点序号；无节点起始的行不在表里
 */
export function buildNodeNumberMap(doc) {
    const map = new Map();
    let node = 0;
    let section = '';
    for (let ln = 1; ln <= doc.lines; ln++) {
        const text = doc.line(ln).text;
        const top = TOP_KEY.exec(text);
        if (top) section = top[1].toLowerCase();

        let isNode = false;
        if (NODE_URI.test(text) && !/^\s*#/.test(text)) {
            isNode = true;
        } else if (YAML_NODE_START.test(text)) {
            isNode = NODE_SECTIONS.has(section);
        }
        if (isNode) map.set(ln, String(++node));
    }
    return map;
}
