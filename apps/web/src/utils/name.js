// 名称校验 —— 与后端 apps/server/src/util.js 的 validateName 保持同一套规则。
//
// 名字会被 encodeURIComponent 编进 URL 路径（/api/sub/:name、/feed/:name …），
// 所以空格是**安全**的；而机场订阅名带空格非常常见（"演示机场 A"、"XX 机场 (专线)"），
// 早先一刀切禁空白会把正常名字挡在门外。
// 真正要拦的是会破坏路径语义或文件系统非法的字符。
const BAD_CHARS = /[/\\?#%*"<>|]/;

/**
 * @param {string} name 待校验名称
 * @param {{ label?: string, allowSlash?: boolean, maxLen?: number }} [opts]
 * @returns {string} 错误信息，空串表示通过
 */
export function validateName(name, { label = '名称', allowSlash = false, maxLen = 0 } = {}) {
    const n = String(name ?? '').trim();
    if (!n) return `${label}不能为空`;
    if (/[\u0000-\u001f\u007f]/.test(n)) return `${label}不能包含控制字符`;
    const probe = allowSlash ? n.replace(/\//g, '') : n;
    if (BAD_CHARS.test(probe)) {
        return allowSlash
            ? `${label}不能包含 \\ ? # % * " < > |`
            : `${label}不能包含 / \\ ? # % * " < > |`;
    }
    if (n.startsWith('.') || n.includes('..')) return `${label}不能以点开头或包含 ..`;
    if (maxLen && n.length > maxLen) return `${label}不能超过 ${maxLen} 个字符`;
    return '';
}
