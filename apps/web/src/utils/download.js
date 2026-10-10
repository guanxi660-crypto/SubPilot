// 卡片「下载」按钮的统一实现。
//
// 订阅 / 组合下载的是**编辑后的订阅**（与「复制订阅」同一条分发链接，
// 不带 target，见 apps/server/src/convert.js 的 raw 通道）：
//   · URI 来源 → base64 通用订阅（.txt）
//   · clash 来源 → clash YAML（.yaml）
// 扩展名按响应头 X-SubPilot-Format 决定，不猜。
// 文件卡片下载文件正文本身（远程文件直接打开其地址）。
import { api } from '../stores/auth.js';

/** 触发浏览器另存为 */
export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 清掉文件名里的非法字符（Windows 与 POSIX 都不接受的都换掉） */
export function safeFilename(name, fallback = 'download') {
    const s = String(name || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim();
    return s || fallback;
}

/**
 * 下载订阅 / 组合（kind: 'sub' | 'col'）。
 * 走 /api/link 拿带派生密钥的分发链接再拉正文 —— 与页面上的「复制订阅」完全同源，
 * 因此内容一致、不需要额外接口。
 */
export async function downloadFeed(kind, name, displayName) {
    const qs = new URLSearchParams({ kind, name });
    const res = await api(`/api/link?${qs.toString()}`);
    const link = res.data?.link;
    if (!link) throw new Error('生成下载链接失败');
    const r = await fetch(link);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const fmt = (r.headers.get('x-subpilot-format') || '').toLowerCase();
    const ext = fmt === 'clash' ? 'yaml' : 'txt';
    saveBlob(await r.blob(), `${safeFilename(displayName || name, kind)}.${ext}`);
}

/** 下载文件卡片：本地内容从 API 取正文；远程文件直接打开其地址 */
export async function downloadFile(f) {
    if (f.source === 'remote' && f.url) {
        window.open(f.url, '_blank', 'noopener');
        return;
    }
    const res = await api(`/api/file/${encodeURIComponent(f.name)}`);
    const content = res.data?.content ?? '';
    saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), safeFilename(f.name, 'file.txt'));
}
