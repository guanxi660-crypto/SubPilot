const WINDOW_MS = 5 * 60 * 1000; 
const MAX_FAILURES = 20; 
const BLOCK_MS = 15 * 60 * 1000; 
const MAX_KEYS = 5000; 

const buckets = new Map();

function prune(now) {
    for (const [k, b] of buckets) {
        const idle = b.blockedUntil > now ? b.blockedUntil : b.windowStart + WINDOW_MS;
        if (idle <= now) buckets.delete(k);
    }
    if (buckets.size <= MAX_KEYS) return;
    
    const sorted = [...buckets.entries()].sort((a, b) => {
        const ea = Math.max(a[1].blockedUntil, a[1].windowStart + WINDOW_MS);
        const eb = Math.max(b[1].blockedUntil, b[1].windowStart + WINDOW_MS);
        return ea - eb;
    });
    for (const [k] of sorted.slice(0, buckets.size - MAX_KEYS)) buckets.delete(k);
}

export function rateLimitKey(ip, path) {
    const p = String(path || '');
    const family = p.startsWith('/ai/')
        ? '/ai'
        : p === '/sub' || p.startsWith('/sub/')
          ? '/sub'
          : p.startsWith('/api/sync/')
            ? '/api/sync'
            : '/api';
    return `${String(ip || 'unknown')}|${family}`;
}

export function checkRateLimit(key, now = Date.now()) {
    prune(now);
    const b = buckets.get(key);
    if (!b) return { blocked: false, retryAfter: 0 };
    if (b.blockedUntil > now) {
        return { blocked: true, retryAfter: Math.max(1, Math.ceil((b.blockedUntil - now) / 1000)) };
    }
    return { blocked: false, retryAfter: 0 };
}

export function noteFailure(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b || now - b.windowStart > WINDOW_MS) {
        b = { count: 0, windowStart: now, blockedUntil: 0 };
    }
    b.count += 1;
    if (b.count >= MAX_FAILURES) {
        b.blockedUntil = now + BLOCK_MS;
        b.count = 0;
        b.windowStart = now;
    }
    buckets.set(key, b);
    prune(now);
    return checkRateLimit(key, now);
}

export function noteSuccess(key) {
    buckets.delete(key);
}

export function resetRateLimits() {
    buckets.clear();
}

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_FAILURES, BLOCK_MS, MAX_KEYS };
