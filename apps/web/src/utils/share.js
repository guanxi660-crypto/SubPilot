// 分享码相关的公共小工具。
//
// 文件页与转换页的成品卡共用这一份 —— URL 的拼法一旦两处各写一遍，
// 迟早会漂移成「一个能点开、一个 403」。

/** 分享码 → 对外可访问的完整 URL。路径段与后端 handleShare 的解析顺序一一对应。 */
export function shareUrl(s) {
    return `${location.origin}/share/${s.type}/${encodeURIComponent(s.name)}?code=${s.code}`;
}

/** ISO 时间 → YYYY-MM-DD */
export function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 有效期选项（生成分享链接时用） */
export const SHARE_EXPIRY = [
    { key: 'days7', label: '7 天' },
    { key: 'days30', label: '1 个月' },
    { key: 'days90', label: '3 个月' },
    { key: 'days365', label: '1 年' },
    { key: 'days', label: '自定义天数' },
    { key: 'never', label: '永久有效' },
    { key: 'date', label: '指定到期日期' },
];

/**
 * 把弹窗里选的有效期换算成后端要的 options。
 * @returns {{kind:'days'|'never'|'date', days?:number, date?:string}} 或 null（缺必填）
 */
export function expiryOptions(kind, days, date) {
    if (kind === 'never') return { kind: 'never' };
    if (kind === 'date') {
        if (!date) return null;
        return { kind: 'date', date };
    }
    if (kind === 'days') return { kind: 'days', days: Math.max(1, Number(days) || 1) };
    // days7 / days30 / days90 / days365
    const n = parseInt(String(kind).slice(4), 10);
    return { kind: 'days', days: Number.isFinite(n) && n > 0 ? n : 7 };
}
