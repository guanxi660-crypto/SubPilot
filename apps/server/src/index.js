import { fail, json, safeEqual, text } from './util.js';
import { checkRateLimit, noteFailure, noteSuccess, rateLimitKey } from './ratelimit.js';
import { handleApi } from './api.js';
import { handleSync } from './sync.js';
import { handleTelegram, autoPushAfterMutation, isTargetMutation } from './telegram.js';
import { handleAiStream, handleAiAbort, handleAiModels, handleAiTest, handleAiPresets } from './ai.js';
import { handleSub, handleConvertLink, handleDownload, handleFeed, handleShare, handleHealthz, clientIp } from './convert.js';

const PROTECTED_PREFIXES = ['/api/', '/ai/'];

export default {
    async fetch(request, env, ctx) {
        return withSecurityHeaders(await handleRequest(request, env, ctx));
    },
};

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
    
    const body = res.status === 204 || res.status === 304 ? null : res.body;
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function handleRequest(request, env, ctx) {
    {
        const url = new URL(request.url);
        const path = url.pathname;
        const query = url.searchParams;
        const method = request.method.toUpperCase();

        
        
        
        
        

        if (path === '/healthz') return handleHealthz();

        
        
        
        
        
        
        
        
        
        
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

            
            
            
            if (path === '/api/convert-link') return await handleConvertLink(request, env, ctx, ctxArgs);

            if (path.startsWith('/api/sync/')) return await handleSync(request, env, ctx, ctxArgs);
            if (path.startsWith('/api/telegram/')) return await handleTelegram(request, env, ctx, ctxArgs);

            if (path.startsWith('/api/')) {
                
                
                
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

            
            if (env.ASSETS) {
                
                
                
                
                
                
                
                
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
            
            
            
            
            if (e?.expose) return fail(e.message, e.status || 400);
            return fail(`服务器内部错误：${e?.message || e}`, 500);
        }
    }
}

function isProtected(path, method) {
    
    if (path.startsWith('/share/')) return false;
    if (path.startsWith('/download/')) return false;
    if (path.startsWith('/feed/')) return false;
    
    
    if (path === '/sub' || path.startsWith('/sub/')) return true;
    if (path === '/healthz') return false;
    return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}

function extractToken(request, query) {
    const auth = request.headers.get('Authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return query.get('token') || '';
}

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
