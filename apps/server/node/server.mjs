// Node / Docker 入口 —— 在纯 Node 里跑 SubPilot 的 Worker 代码。
//
// 为什么不用 miniflare / workerd 直接跑：
//   那两个的定位是**开发期模拟器**（`wrangler dev` 本身就是它们），依赖 workerd
//   这个平台相关的原生二进制，官方也不把它当生产运行时。这里需要的其实只是
//   「把 web 标准的 Request/Response 接到 node:http 上」，外加一个存储 —— 这点
//   胶水代码比拉进一整个 workerd 更可控，镜像也小一个数量级。
//
// 适配清单（对照 src/ 里实际用到的 Workers 专有接口，共 4 个）：
//   env.DATA（KV）            → 换成 SQLite 驱动，经 env.STORE 注入（node/sqlite-store.mjs）
//   env.ASSETS.fetch          → node/assets.mjs（含 SPA 回退）
//   ctx.waitUntil             → 吞掉异常的 fire-and-forget
//   env.SUBPILOT_TOKEN / SUB_BACKEND → 进程环境变量
// 其余（fetch、crypto.subtle、atob/btoa、ReadableStream、AbortSignal.timeout）
// Node 18+ 都原生具备，无需垫片。
//
// 相比 Workers 侧额外做的两件性能优化：
//   1. **响应压缩**。Workers 部署时压缩由 Cloudflare 边缘做，自建 Node 没有这层，
//      1MB 的前端 JS 会原样发出去。这里自己 br/gzip，并把压缩结果按内容缓存。
//   2. **SQLite 行级写入 + WAL**，见 sqlite-store.mjs。

import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import worker from '../src/index.js';
import { createAssets } from './assets.mjs';
import { createSqliteStore } from './sqlite-store.mjs';

// Node 19 起 globalThis.crypto 才是默认全局；18 上要显式补。
// 本项目 engines 要求 >=20，但补一行不花钱，省得有人用 18 跑出
// 「crypto.subtle is undefined」这种难查的报错。
if (!globalThis.crypto?.subtle) {
    const { webcrypto } = await import('node:crypto');
    globalThis.crypto = webcrypto;
}

const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = resolve(process.env.DB_FILE || join(HERE, '..', 'data', 'subpilot.db'));
const ASSETS_DIR = resolve(process.env.ASSETS_DIR || join(HERE, '..', '..', 'web', 'dist'));

const store = createSqliteStore(DB_FILE);

const env = {
    SUBPILOT_TOKEN: process.env.SUBPILOT_TOKEN || '',
    SUB_BACKEND: process.env.SUB_BACKEND || '',
    // SSRF 守卫的逃生开关（netguard.js 的 ssrfOptions 读它）。给「SCE / WebDAV /
    // 大模型都跑在内网」的自建部署用；默认关闭，即内网地址一律拒绝。
    SUBPILOT_ALLOW_PRIVATE_FETCH: process.env.SUBPILOT_ALLOW_PRIVATE_FETCH || '',
    // SSRF 守卫的「域名解析复核」（审计 M2）。
    // Workers 运行时拿不到 DNS 查询能力，自建侧可以 —— 于是「公网域名解析到
    // 127.0.0.1」这种 DNS rebinding 也能挡住（静态 DNS 场景；攻击者能在校验与
    // 连接之间翻转解析结果的极端情况仍无法根治，见 README 已知限制）。
    RESOLVE_HOST: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
    STORE: store,
    ASSETS: createAssets(ASSETS_DIR),
};

// Worker 里 ctx 只用来兜后台任务（统计计数、变动即时推送）。这些任务失败绝不能
// 影响正在返回的响应，所以统一吞掉异常 —— 与 Workers 上 waitUntil 的语义一致。
const ctx = {
    waitUntil(promise) {
        Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException() {},
};

// ---- 请求桥接：node:http → web Request ----

async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return chunks.length ? Buffer.concat(chunks) : undefined;
}

/**
 * 这些头不能透传：`host` 由 URL 承载（undici 会拒绝手工设置），
 * `content-length` / `transfer-encoding` 由 Request 自己按 body 算，
 * `connection` 是逐跳头。传了反而抛错或产生不一致的报文。
 */
const SKIP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'expect']);

async function toWebRequest(req) {
    // 反向代理后面时，原始协议与域名只在 X-Forwarded-* 里。
    // 这对 /feed、/download 的链接生成是**功能性**的：publicBaseUrl() 取的是
    // 请求 URL 的 origin，取错就会把 http://内网地址 写进给客户端的配置里。
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
    // ---- 来源 IP 可信化（审计 L1）----
    // convert.js 的 clientIp() 无条件信任 CF-Connecting-IP / X-Real-IP /
    // X-Forwarded-For。Cloudflare 部署下这些头由平台覆写、不可伪造；但自建部署下
    // 客户端随手加一个 `CF-Connecting-IP: 1.2.3.4` 就能把分发统计写成任意 IP。
    //
    // 所以这里先把客户端自带的 IP 头**全部删掉**，再写入我们认定可信的那一个：
    //   · 默认（TRUST_PROXY 未开）：socket 的对端地址。
    //   · TRUST_PROXY=1：前面有自己部署的反代，取 X-Forwarded-For 的**最后一跳**
    //     —— 那一跳是反代写进去的；客户端自己伪造的会被挤到前面去。
    for (const h of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) headers.delete(h);
    const clientIp = resolveClientIp(req);
    if (clientIp) headers.set('cf-connecting-ip', clientIp);

    const method = (req.method || 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    return new Request(url, { method, headers, body });
}

/** 反代部署时是否信任转发头。默认不信任 —— 见 toWebRequest 里的说明。 */
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));

/** 认定可信的客户端 IP。 */
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

// ---- 响应压缩 ----
//
// 压缩结果按 (内容哈希) 缓存。静态资源是内容寻址的、内容不变，所以缓存命中率
// 接近 100%；br 对 1MB 的 JS 要花几十毫秒，第一次之后就白拿。
const compressCache = new Map();
const COMPRESS_CACHE_MAX = 64;

// 超过这个体积就不压了：一是压大文件会明显占住事件循环，二是订阅配置基本都在
// 几百 KB 以内，再大通常是用户在下载别的东西。
const COMPRESS_LIMIT = 8 * 1024 * 1024;
const COMPRESS_MIN = 1024; // 小响应压缩后反而更大，不值当

const COMPRESSIBLE_TYPE =
    /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|sqlite)|image\/svg\+xml)/i;

function pickEncoding(acceptEncoding) {
    const ae = String(acceptEncoding || '');
    if (/(?:^|[,\s])br(?:\s*;|,|$)/.test(ae)) return 'br';
    if (/(?:^|[,\s])gzip(?:\s*;|,|$)/.test(ae)) return 'gzip';
    return '';
}

/**
 * 读流，但最多读到 limit 字节；超了就返回剩余未读的 reader，
 * 调用方把「已读到的部分 + 剩余流」原样转发，不做压缩。
 */
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
                // 默认质量 11 对 1MB 的文件要几百毫秒；质量 5 已经能拿到默认级别
                // 九成左右的压缩率，速度快一个数量级。
                [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
            },
        });
    }
    return gzipSync(buf, { level: 6 });
}

function cacheKey(buf) {
    // 用长度 + 头尾采样做键：不必真算哈希，够区分不同资源就行，
    // 且避免了每次请求都跑一遍哈希的开销。
    return `${buf.length}:${buf[0] ?? 0}:${buf[buf.length - 1] ?? 0}`;
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
    // 压不小就别压（小文本或已压缩过的内容）
    if (out.byteLength >= bodyBuf.byteLength) return null;

    if (compressCache.size >= COMPRESS_CACHE_MAX) {
        // 简单的 FIFO 淘汰。缓存条目是「按内容」的，没有热点偏好，
        // LRU 的额外记账不值得。
        compressCache.delete(compressCache.keys().next().value);
    }
    compressCache.set(key, out);
    return { buf: out, encoding };
}

// ---- 响应桥接：web Response → node:http ----

async function writeWebResponse(res, response, reqMethod, acceptEncoding) {
    res.statusCode = response.status;
    res.statusMessage = response.statusText || '';

    const contentType = response.headers.get('content-type') || '';
    const isEventStream = contentType.includes('text/event-stream');
    const alreadyEncoded = response.headers.has('content-encoding');
    const noBody =
        !response.body || reqMethod === 'HEAD' || response.status === 204 || response.status === 304;

    // SSE 绝不缓冲：AI 助手是逐 token 推送的，缓冲等于把流式体验全废掉。
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

    // 超过压缩上限：把已读到的部分 + 剩余流原样转发，不做压缩。
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
        // 长度已知就写死 Content-Length，省掉 chunked 编码的每块开销
        res.setHeader('Content-Length', bodyBuf.byteLength);
        res.end(bodyBuf);
    }
}

/** 已缓冲的分片 + 尚未读完的 reader，按原顺序吐出来。 */
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
        if (k.toLowerCase() === 'set-cookie') continue; // 单独处理，见下
        try {
            res.setHeader(k, v);
        } catch {
            // 个别头（如与 body 不匹配的 content-encoding）设置失败不该让整请求 500
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

// ---- 服务器 ----

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
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json;charset=UTF-8');
        res.end(JSON.stringify({ status: 'failed', message: `服务器内部错误：${e?.message || e}` }));
    }
});

// AI 助手是长连接 SSE，而 requestTimeout 量的是「请求开始 → 响应结束」的总时长，
// 默认 300s 会把长回答拦腰切断。这里直接关掉：单用户面板不靠它防慢速攻击，
// 前面若有 nginx 也要记得 proxy_read_timeout 与 proxy_buffering off。
server.requestTimeout = 0;
server.headersTimeout = 60_000;
// 比常见的 60s 空闲超时略长，避免反向代理复用连接时撞上服务端先关。
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
            // WAL 落回主库，保证「拷走 subpilot.db 一个文件」就是完整备份
            store.checkpoint();
            store.close();
            process.exit(0);
        });
        // 有长连接（SSE）挂着时 close() 不会返回，给 5s 强制退出兜底
        setTimeout(() => {
            store.checkpoint();
            store.close();
            process.exit(0);
        }, 5000).unref();
    });
}
