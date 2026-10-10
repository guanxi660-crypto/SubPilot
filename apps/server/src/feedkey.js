import { bytesToB64url, randId, nowIso } from './util.js';

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

export async function ensureFeedSalt(env, mutateFn) {
    return mutateFn(env, (snap) => {
        if (!snap.settings.feedSalt) {
            snap.settings.feedSalt = randId(24);
            snap.settings.feedSaltCreatedAt = nowIso();
        }
        return snap.settings.feedSalt;
    });
}

export async function checkFeedKey(env, settings, kind, name, provided) {
    if (!provided) return false;
    const expect = await deriveFeedKey(env, settings, kind, name);
    if (!expect) return false;
    
    if (String(provided).length !== expect.length) return false;
    let diff = 0;
    for (let i = 0; i < expect.length; i++) {
        diff |= provided.charCodeAt(i) ^ expect.charCodeAt(i);
    }
    return diff === 0;
}
