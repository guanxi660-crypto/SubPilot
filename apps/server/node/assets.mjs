// 静态资源服务 —— 复刻 wrangler 的 assets 绑定语义（含 SPA 回退）。
//
// ⚠️ 有个不能省的细节：src/index.js 是靠 **Content-Type** 判断「是不是落到了
// SPA 回退」的 —— assets 目录里只有 js / css / 字体 / 图片，一旦返回 text/html
// 就说明该文件根本不存在，于是给出真 404。所以未命中时**必须**回 index.html
// 且带上 text/html，否则那道「构建产物 404 会被静默白屏」的防线就失效了
// （浏览器拿到 text/html 的模块脚本会拒绝执行，表现是白屏且没有报错线索）。
//
// 只读、不列目录、不做 Range 请求 —— 这些资源都是同域的小文件（dist 总计约 1MB），
// 没必要为它们引入一整套静态服务器。

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

function mimeOf(p) {
    return MIME[extname(p).toLowerCase()] || 'application/octet-stream';
}

/**
 * 把 URL 路径解析成 root 内的真实路径。
 * 越界（`..`、绝对路径、编码后的穿越）一律返回 null —— 静态服务不能把
 * 文件系统暴露出去，哪怕这是个单用户面板。
 */
function within(root, rel) {
    const p = resolve(root, rel);
    if (p !== root && !p.startsWith(root + sep)) return null;
    return p;
}

async function fileResponse(path, st, { head, immutable, reqHeaders }) {
    // 弱 ETag：mtime + size。dist 里的文件名带内容 hash，本来就不会重复，
    // 这个 ETag 主要是给 index.html 这种固定名字用的。
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
        'Content-Type': mimeOf(path),
        ETag: etag,
        // 带内容 hash 的产物可以长期强缓存；其余（index.html、favicon）必须回源校验，
        // 否则前端发新版本后用户会一直拿到旧的 index.html 去引用已删除的旧 JS。
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };

    if (reqHeaders?.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers });
    }
    if (head) return new Response(null, { status: 200, headers });

    return new Response(await readFile(path), { status: 200, headers });
}

export function createAssets(root) {
    const rootAbs = resolve(root);

    return {
        async fetch(request) {
            const url = new URL(request.url);
            const head = request.method === 'HEAD';

            let pathname;
            try {
                pathname = decodeURIComponent(url.pathname);
            } catch {
                return new Response('Bad Request', { status: 400 });
            }

            // 只接受 GET / HEAD，其余方法落到静态分支没有意义
            if (request.method !== 'GET' && !head) {
                return new Response('Method Not Allowed', { status: 405 });
            }

            const hit = within(rootAbs, pathname.replace(/^\/+/, ''));
            if (hit) {
                const st = await stat(hit).catch(() => null);
                if (st?.isFile()) {
                    // vite 的产物目录叫 assets/，文件名带 hash —— 可以强缓存
                    const immutable = pathname.startsWith('/assets/');
                    return fileResponse(hit, st, { head, immutable, reqHeaders: request.headers });
                }
            }

            // SPA 回退：任何未命中的路径都交给前端路由（hash 路由 + history 兜底）
            const index = join(rootAbs, 'index.html');
            const st = await stat(index).catch(() => null);
            if (!st?.isFile()) {
                return new Response('前端资源未找到。请先执行 `npm run build`。', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                });
            }
            return fileResponse(index, st, { head, immutable: false, reqHeaders: request.headers });
        },
    };
}
