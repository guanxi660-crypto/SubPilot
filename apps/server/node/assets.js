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

function within(root, rel) {
    const p = resolve(root, rel);
    if (p !== root && !p.startsWith(root + sep)) return null;
    return p;
}

async function fileResponse(path, st, { head, immutable, reqHeaders }) {
    
    
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
        'Content-Type': mimeOf(path),
        ETag: etag,
        
        
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

            
            if (request.method !== 'GET' && !head) {
                return new Response('Method Not Allowed', { status: 405 });
            }

            const hit = within(rootAbs, pathname.replace(/^\/+/, ''));
            if (hit) {
                const st = await stat(hit).catch(() => null);
                if (st?.isFile()) {
                    
                    const immutable = pathname.startsWith('/assets/');
                    return fileResponse(hit, st, { head, immutable, reqHeaders: request.headers });
                }
            }

            
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
