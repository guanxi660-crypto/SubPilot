
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';

import worker from '../src/index.js';
import { createAssets } from './assets.mjs';
import { createSqliteStore } from './sqlite-store.mjs';


if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import('node:crypto');
    globalThis.crypto = webcrypto;
}

const HERE = dirname(fileURLToPath(import.meta.url));

function readPort() {
    const raw = String(process.env.PORT ?? '').trim();
    if (!raw) return 8795;
    const n = Number(raw);
    
    
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.warn(`PORT 非法（"${raw}"），回落到 8795`);
        return 8795;
    }
    return n;
}

const PORT = readPort();
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = resolve(process.env.DB_FILE || join(HERE, '..', 'data', 'subpilot.db'));
const ASSETS_DIR = resolve(process.env.ASSETS_DIR || join(HERE, '..', '..', 'web', 'dist'));

const store = createSqliteStore(DB_FILE);

const env = {
    SUBPILOT_TOKEN: process.env.SUBPILOT_TOKEN || '',
    SUB_BACKEND: process.env.SUB_BACKEND || '',
    
    
    SUBPILOT_ALLOW_PRIVATE_FETCH: process.env.SUBPILOT_ALLOW_PRIVATE_FETCH || '',
    
    
    
    
    RESOLVE_HOST: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
    STORE: store,
    ASSETS: createAssets(ASSETS_DIR),
};


const ctx = {
    waitUntil(promise) {
        Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException() {},
};



const MAX_BODY_BYTES = 24 * 1024 * 1024;

class BodyTooLarge extends Error {}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
            req.destroy();
            throw new BodyTooLarge();
        }
        chunks.push(c);
    }
    return chunks.length ? Buffer.concat(chunks) : undefined;
}


const SKIP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'expect']);

async function toWebRequest(req) {
    
    
    
    const proto =
        firstValue(req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
    const host = firstValue(req.headers['x-forwarded-host']) || req.headers.host || `${HOST}:${PORT}`;
    const url = `${proto}://${host}${req.url || '/'}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (SKIP_HEADERS.has(k)) continue;
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else if (v !== undefined) headers.set(k, v);
    }
    
    
    
    
    
    
    
    
    
    for (const h of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) headers.delete(h);
    const clientIp = resolveClientIp(req);
    if (clientIp) headers.set('cf-connecting-ip', clientIp);

    const method = (req.method || 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    return new Request(url, { method, headers, body });
}


const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));


function resolveClientIp(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        const raw = Array.isArray(xff) ? xff.join(',') : String(xff || '');
        const hops = raw
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
        const real = firstValue(req.headers['x-real-ip']);
        if (real) return real;
    }
    return req.socket.remoteAddress || '';
}

function firstValue(v) {
    const s = Array.isArray(v) ? v[0] : v;
    return String(s || '').split(',')[0].trim();
}


const compressCache = new Map();
const COMPRESS_CACHE_MAX = 64;


const COMPRESS_LIMIT = 8 * 1024 * 1024;
const COMPRESS_MIN = 1024; 

const COMPRESSIBLE_TYPE =
    /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|sqlite)|image\/svg\+xml)/i;

function pickEncoding(acceptEncoding) {
    const ae = String(acceptEncoding || '');
    if (/(?:^|[,\s])br(?:\s*;|,|$)/.test(ae)) return 'br';
    if (/(?:^|[,\s])gzip(?:\s*;|,|$)/.test(ae)) return 'gzip';
    return '';
}


async function readUpTo(stream, limit) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return { chunks, size, rest: null };
        chunks.push(value);
        size += value.byteLength;
        if (size > limit) return { chunks, size, rest: reader };
    }
}

function compress(buf, encoding) {
    if (encoding === 'br') {
        return brotliCompressSync(buf, {
            params: {
                
                
                [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
            },
        });
    }
    return gzipSync(buf, { level: 6 });
}

function cacheKey(buf) {
    
    
    
    
    
    
    
    return createHash('sha1').update(buf).digest('base64url');
}

async function maybeCompress(bodyBuf, contentType, acceptEncoding) {
    if (bodyBuf.byteLength < COMPRESS_MIN) return null;
    if (!COMPRESSIBLE_TYPE.test(contentType)) return null;
    const encoding = pickEncoding(acceptEncoding);
    if (!encoding) return null;

    const key = `${encoding}:${cacheKey(bodyBuf)}`;
    const hit = compressCache.get(key);
    if (hit) return { buf: hit, encoding };

    const out = compress(bodyBuf, encoding);
    
    if (out.byteLength >= bodyBuf.byteLength) return null;

    if (compressCache.size >= COMPRESS_CACHE_MAX) {
        
        
        compressCache.delete(compressCache.keys().next().value);
    }
    compressCache.set(key, out);
    return { buf: out, encoding };
}



async function writeWebResponse(res, response, reqMethod, acceptEncoding) {
    res.statusCode = response.status;
    res.statusMessage = response.statusText || '';

    const contentType = response.headers.get('content-type') || '';
    const isEventStream = contentType.includes('text/event-stream');
    const alreadyEncoded = response.headers.has('content-encoding');
    const noBody =
        !response.body || reqMethod === 'HEAD' || response.status === 204 || response.status === 304;

    
    if (noBody || isEventStream || alreadyEncoded) {
        copyHeaders(res, response);
        if (noBody) {
            res.end();
            return;
        }
        res.flushHeaders?.();
        pipeStream(res, response.body);
        return;
    }

    const { chunks, rest } = await readUpTo(response.body, COMPRESS_LIMIT);

    
    if (rest) {
        copyHeaders(res, response);
        res.flushHeaders?.();
        Readable.from(replay(chunks, rest)).pipe(res);
        return;
    }

    const bodyBuf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const packed = await maybeCompress(bodyBuf, contentType, acceptEncoding);

    copyHeaders(res, response);
    appendVary(res, 'Accept-Encoding');
    if (packed) {
        res.setHeader('Content-Encoding', packed.encoding);
        res.setHeader('Content-Length', packed.buf.byteLength);
        res.end(packed.buf);
    } else {
        
        res.setHeader('Content-Length', bodyBuf.byteLength);
        res.end(bodyBuf);
    }
}


async function* replay(chunks, reader) {
    for (const c of chunks) yield Buffer.from(c);
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
    }
}

function appendVary(res, value) {
    const cur = res.getHeader('Vary');
    if (!cur) res.setHeader('Vary', value);
    else if (!String(cur).includes(value)) res.setHeader('Vary', `${cur}, ${value}`);
}

function copyHeaders(res, response) {
    for (const [k, v] of response.headers) {
        if (k.toLowerCase() === 'set-cookie') continue; 
        try {
            res.setHeader(k, v);
        } catch {
            
        }
    }
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) res.setHeader('set-cookie', cookies);
}

function pipeStream(res, body) {
    const stream = Readable.fromWeb(body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}



const server = createServer({ noDelay: true }, async (req, res) => {
    try {
        const request = await toWebRequest(req);
        const response = await worker.fetch(request, env, ctx);
        await writeWebResponse(res, response, req.method, req.headers['accept-encoding'] || '');
    } catch (e) {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        if (e instanceof BodyTooLarge) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'application/json;charset=UTF-8');
            res.end(JSON.stringify({ status: 'failed', message: '请求体过大' }));
            return;
        }
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json;charset=UTF-8');
        res.end(JSON.stringify({ status: 'failed', message: `服务器内部错误：${e?.message || e}` }));
    }
});


process.on('unhandledRejection', (e) => {
    console.error('未处理的 Promise 拒绝：', e?.stack || e);
});
process.on('uncaughtException', (e) => {
    console.error('未捕获异常：', e?.stack || e);
});


server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.keepAliveTimeout = 65_000;

server.listen(PORT, HOST, () => {
    const token = env.SUBPILOT_TOKEN;
    console.log('SubPilot (Node) 已启动');
    console.log(`  监听      http://${HOST}:${PORT}`);
    console.log(`  数据库    ${DB_FILE}  (SQLite · WAL)`);
    console.log(`  静态资源  ${ASSETS_DIR}`);
    console.log(`  转换后端  ${env.SUB_BACKEND || '（未设置，可在「转换」页配置）'}`);
    console.log(`  访问令牌  ${token ? `已设置（${token.slice(0, 3)}***）` : '未设置 —— 受保护接口一律 401'}`);
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (closing) return;
        closing = true;
        console.log(`\n收到 ${sig}，正在关闭…`);
        server.close(() => {
            
            store.checkpoint();
            store.close();
            process.exit(0);
        });
        
        setTimeout(() => {
            store.checkpoint();
            store.close();
            process.exit(0);
        }, 5000).unref();
    });
}
