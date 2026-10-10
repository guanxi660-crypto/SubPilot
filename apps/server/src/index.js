// SubPilot 入口。
//
// 路由分工：
//   /api/*      本站数据（订阅 / 组合 / 文件 / 分享码 / 设置 / 统计）
//   /api/sync/* Gist / WebDAV 备份恢复
//   /api/telegram/*  TG 推送（配置 / 测试 / 推送）
//   /ai/*       AI 助手（SSE）
//   /sub        转换（转发 SubConverter-Extended）
//   /api/convert-link 成品链接（只要那条后端格式的地址，不真转换）
//   /download/* 分发链接（客户端直接拉）
//   /feed/*     处理后的节点列表（供 SCE 拉取）
//   /share/*    分享码分发（公开，分享码本身即凭证）
//   /healthz    存活检查
//   其余        静态资源（前端 SPA）
//
// 鉴权 fail-closed：SUBPILOT_TOKEN 未配置时，所有受保护路由一律 401，不做放行。

import { fail, json, safeEqual, text } from './util.js';
import { checkRateLimit, noteFailure, noteSuccess, rateLimitKey } from './ratelimit.js';
import { handleApi } from './api.js';
import { handleSync } from './sync.js';
import { handleTelegram, autoPushAfterMutation, isTargetMutation } from './telegram.js';
import { handleAiStream, handleAiAbort, handleAiModels, handleAiTest, handleAiPresets } from './ai.js';
import { handleSub, handleConvertLink, handleDownload, handleFeed, handleShare, handleHealthz, clientIp } from './convert.js';

// 需要管理令牌的前缀。
// 注意 /feed/ 与 /download/ 不在这里 —— 它们的地址要写进客户端配置长期使用，
// 因此走**派生的只读分发密钥**（?ft=）自校验，见 convert.js 的 authorizeDistribution。
// 把管理令牌塞进这些 URL 等于把管理员凭据发给每个拿到配置的人。
const PROTECTED_PREFIXES = ['/api/', '/ai/'];

export default {
    async fetch(request, env, ctx) {
        return withSecurityHeaders(await handleRequest(request, env, ctx));
    },
};

/**
 * 全站安全响应头。
 *
 * 为什么必须有 nosniff：`/share/file/<名>?code=` 以 text/plain 返回**用户上传的
 * 任意文本**，而允许的扩展名里有 html / htm / js。没有 nosniff 时，浏览器的
 * MIME 嗅探可能把 text/plain 当 HTML 解析 —— 那就是同源下的存储型 XSS，
 * 而同源意味着可以调用全部 /api/*（令牌在 localStorage）。
 *
 * CSP 暂不在这里加：前端用了大量内联 style（Tailwind 的 :style 绑定、CSS 变量），
 * 收紧 style-src 会直接把布局打坏，需要单独评估（见 AUDIT.md M4）。
 */
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
};

function withSecurityHeaders(res) {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        if (!headers.has(k)) headers.set(k, v);
    }
    // 204 / 304 不允许带 body，重建时必须显式置空
    const body = res.status === 204 || res.status === 304 ? null : res.body;
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function handleRequest(request, env, ctx) {
    {
        const url = new URL(request.url);
        const path = url.pathname;
        const query = url.searchParams;
        const method = request.method.toUpperCase();

        // 这里原本有一段 OPTIONS 预检特判，返回 Access-Control-Allow-Origin: * ——
        // 但真实响应由 util.js 的 json()/text() 构造、**不带任何 CORS 头**，
        // 所以预检通过也会被浏览器拦下，属于自相矛盾的死代码（审计 L4）。
        // 生产是同域部署（前端由同一个 Worker 的 assets 提供），dev 走 vite 代理，
        // 都不需要 CORS。真要开放跨域，必须同时给实际响应补头，不能只留预检。

        if (path === '/healthz') return handleHealthz();

        // ---- 鉴权 ----
        // 失败限流（审计 M3）：只对**失败**计数，成功一次即清零。
        // 没有它时，S1 那种「可离线枚举的令牌判定」配合不限流的接口就是一个
        // 可以慢慢试到对的爆破面。
        //
        // ⚠️ 顺序很关键：**先比令牌，再判封禁**。
        // 反过来的话（封禁命中就直接 429），用户自己在浏览器里连着输错几次就会被
        // 自己锁在门外 15 分钟 —— 单用户面板里这是纯粹的自伤，而且没有任何绕过
        // 风险：能通过令牌校验的人本来就该放行。爆破者没有正确令牌，照样撞在 429 上。
        // safeEqual 是常量时间的，所以这个顺序也不泄漏额外信息。
        const tokenFromAuth = extractToken(request, query);
        if (isProtected(path, method)) {
            const expected = String(env.SUBPILOT_TOKEN || '');
            if (!expected) {
                return fail(
                    '站点尚未配置访问令牌（SUBPILOT_TOKEN）。请先在 Worker 里设置该 secret 再使用。',
                    401,
                );
            }

            const rlKey = rateLimitKey(clientIp(request), path);
            const tokenOk = !!tokenFromAuth && safeEqual(tokenFromAuth, expected);

            if (tokenOk) {
                noteSuccess(rlKey);
            } else {
                const pre = checkRateLimit(rlKey);
                if (pre.blocked) return tooManyRequests(pre.retryAfter);
                const after = noteFailure(rlKey);
                if (after.blocked) return tooManyRequests(after.retryAfter);
                return fail('需要访问令牌', 401);
            }
        }

        const ctxArgs = { path, query, method, tokenFromAuth };

        try {
            if (path === '/sub') return await handleSub(request, env, ctx, ctxArgs);

            // 成品链接（转换后端格式）。放在 /api/ 分支**之前** —— 否则会被
            // handleApi 当成「未知的 api 资源」接走。它属于转换，不属于本站数据，
            // 所以留在 convert.js 里、由这里直接路由。
            if (path === '/api/convert-link') return await handleConvertLink(request, env, ctx, ctxArgs);

            if (path.startsWith('/api/sync/')) return await handleSync(request, env, ctx, ctxArgs);
            if (path.startsWith('/api/telegram/')) return await handleTelegram(request, env, ctx, ctxArgs);

            if (path.startsWith('/api/')) {
                // 变动即时推送需要看请求体（新建时的名称在 body 里），而 handleApi 会把
                // body 读掉 —— 所以先克隆一份。只在可能触发的路径上克隆，
                // 免得给备份导入这种大 body 平白多一次缓冲。
                const watch = isTargetMutation(path, method);
                const cloned = watch ? request.clone() : null;
                const res = await handleApi(request, env, ctx, ctxArgs);
                if (cloned && res.ok && ctx?.waitUntil) {
                    ctx.waitUntil(
                        cloned
                            .text()
                            .then((t) => autoPushAfterMutation(request, env, t, { path, method }))
                            .catch(() => {}),
                    );
                }
                return res;
            }

            if (path === '/ai/assistant/stream' && method === 'POST') {
                return await handleAiStream(request, env, ctx);
            }
            if (path === '/ai/assistant/abort' && method === 'POST') return await handleAiAbort(request);
            if (path === '/ai/models' && method === 'POST') return await handleAiModels(request, env);
            if (path === '/ai/settings/test' && method === 'POST') return await handleAiTest(request, env);
            if (path === '/ai/presets' && method === 'GET') return handleAiPresets();
            if (path.startsWith('/ai/')) return fail(`未知 AI 接口：${method} ${path}`, 404);

            if (path.startsWith('/download/')) return await handleDownload(request, env, ctx, ctxArgs);
            if (path.startsWith('/feed/')) return await handleFeed(request, env, ctx, ctxArgs);
            if (path.startsWith('/share/')) return await handleShare(request, env, ctx, ctxArgs);

            // ---- 静态资源 / SPA ----
            if (env.ASSETS) {
                // 构建产物路径不能走 SPA 回退：assets 找不到时若返回 index.html，
                // 浏览器会因为 MIME 是 text/html 拒绝执行模块脚本，表现是**静默白屏**，
                // 排查起来很费劲。这里直接给真 404，让问题在控制台里看得见。
                //
                // 注意不能只判断 status===404：assets 配了 not_found_handling:
                // single-page-application，未命中的路径会被回退成 200 + index.html。
                // 所以还要看 Content-Type —— assets 目录下只有 js/css/字体/图片，
                // 一旦返回 text/html 就说明落到了 SPA 回退，即该文件根本不存在。
                if (path.startsWith('/assets/')) {
                    const asset = await env.ASSETS.fetch(request);
                    const type = asset.headers.get('Content-Type') || '';
                    if (asset.status === 404 || type.includes('text/html')) {
                        return text(
                            '静态资源不存在。若刚重新构建过前端，请重启 dev 服务或重新部署。',
                            404,
                        );
                    }
                    return asset;
                }

                const res = await env.ASSETS.fetch(request);
                // 未构建前端时 assets 会 404，给一条能看懂的提示
                if (res.status === 404 && method === 'GET') {
                    return text(
                        '前端资源未找到。请在项目根目录执行 `npm run build` 后再启动 / 部署。',
                        404,
                    );
                }
                return res;
            }
            return text('未绑定静态资源（ASSETS）。请先 npm run build。', 404);
        } catch (e) {
            // 带 expose 标记的异常是**预期内的业务失败**（SSRF 被拦、正文超限、
            // 写冲突等，见 util.js 的 ApiError / netguard.js / storage.js）——
            // 它们可能从很深的工具函数里抛出，中途没有合适的 catch，所以在入口
            // 统一翻成对应的状态码。其余异常一律折叠，不把内部细节回给客户端。
            if (e?.expose) return fail(e.message, e.status || 400);
            return fail(`服务器内部错误：${e?.message || e}`, 500);
        }
    }
}

function isProtected(path, method) {
    // 这些路由自带鉴权通道（分发密钥 / 分享码），不在这里拦
    if (path.startsWith('/share/')) return false;
    if (path.startsWith('/download/')) return false;
    if (path.startsWith('/feed/')) return false;
    // /sub 与 /sub/ 都要挡。只写 path === '/sub' 的话，带尾斜杠的写法会漏下去
    // 落到静态资源分支（目前没有可利用的绕过，但这种边界不该留口子）。
    if (path === '/sub' || path.startsWith('/sub/')) return true;
    if (path === '/healthz') return false;
    return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}

function extractToken(request, query) {
    const auth = request.headers.get('Authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return query.get('token') || '';
}

/** 限流响应。带 Retry-After（秒），让客户端知道多久后能再试。 */
function tooManyRequests(retryAfter) {
    return json(
        {
            status: 'failed',
            message: `令牌校验失败次数过多，已暂时拒绝来自该来源的请求。请在 ${retryAfter} 秒后重试。`,
        },
        429,
        { 'Retry-After': String(retryAfter) },
    );
}
