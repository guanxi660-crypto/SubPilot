// 分发用的派生密钥。
//
// 问题：feed / download 地址会被写进客户端配置（Mihomo 的 proxy-providers、
// Surge 的 MANAGED-CONFIG 都会把 URL 原样存下来）。如果这个 URL 里放的是
// 管理令牌 SUBPILOT_TOKEN，那等于把「能改所有订阅、能删所有文件」的凭据
// 交给了每一个拿到配置的人 —— 包括截图、群聊、二手设备。
//
// 做法：用 HMAC 派生一个**只对某一个订阅/组合有效、只读**的密钥。
//   key = base64url(HMAC-SHA256(SUBPILOT_TOKEN + '|' + salt, "kind:name"))
// 特性：
//   · 单向 —— 拿到派生密钥推不出管理令牌
//   · 限定范围 —— 一个订阅一个密钥，泄了也只能读那一个
//   · 无状态 —— 不需要为每个订阅存一行数据，服务端算得出来就能校验
//   · 可整体吊销 —— 轮换 settings.feedSalt 即让所有已发出的链接失效

import { bytesToB64url, randId, nowIso } from './util.js';

/** 派生分发密钥。salt 不存在时返回空串（调用方据此回落到管理令牌通道）。 */
export async function deriveFeedKey(env, settings, kind, name) {
    const secret = String(env.SUBPILOT_TOKEN || '');
    if (!secret) return '';
    const salt = String(settings?.feedSalt || '');
    if (!salt) return '';
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(`${secret}|${salt}`),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${kind}:${name}`));
    return bytesToB64url(new Uint8Array(sig)).slice(0, 32);
}

/** 确保 settings.feedSalt 存在（首次调用时生成并持久化） */
export async function ensureFeedSalt(env, mutateFn) {
    return mutateFn(env, (snap) => {
        if (!snap.settings.feedSalt) {
            snap.settings.feedSalt = randId(24);
            snap.settings.feedSaltCreatedAt = nowIso();
        }
        return snap.settings.feedSalt;
    });
}

/**
 * 校验请求里的分发密钥。
 * @returns {Promise<boolean>} 是否放行
 */
export async function checkFeedKey(env, settings, kind, name, provided) {
    if (!provided) return false;
    const expect = await deriveFeedKey(env, settings, kind, name);
    if (!expect) return false;
    // 长度不同直接判否；长度相同则逐字符比（避免 === 的短路差异，虽然这里不算敏感）
    if (String(provided).length !== expect.length) return false;
    let diff = 0;
    for (let i = 0; i < expect.length; i++) {
        diff |= provided.charCodeAt(i) ^ expect.charCodeAt(i);
    }
    return diff === 0;
}
