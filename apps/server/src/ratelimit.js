// 令牌校验失败的限流（审计 M3）。
//
// 之前鉴权分支只有「令牌相等 → 放行 / 否则 401」，没有失败计数、没有退避、没有
// 日志。单独看是「弱令牌可被爆破」；与 S1（常量时间比较比错对象）组合后，攻击者
// 可以在完全不被察觉的情况下持续提交候选串。
//
// 实现是**进程内**的滑动窗口：
//   · Node / Docker：单进程，能真正拦住。
//   · Cloudflare Workers：内存态是**单 isolate** 的，跨 isolate / 跨 colo 不共享，
//     所以只是「显著提高爆破成本」而不是硬保证。要硬保证得用 Durable Object，
//     或用 Cloudflare 的 Rate Limiting 规则在边缘挡（两者都在已知限制里写明）。
//
// 只对**失败**计数：正常用户偶尔打错一次令牌不该被罚；一旦成功就把计数清零，
// 避免「密码输错几次、后来输对了却仍在冷却期」这种恼人行为。

const WINDOW_MS = 5 * 60 * 1000; // 统计窗口
const MAX_FAILURES = 20; // 窗口内允许的失败次数
const BLOCK_MS = 15 * 60 * 1000; // 超限后的封禁时长
const MAX_KEYS = 5000; // 桶上限，防内存被大量伪造 IP 撑爆

/** key → { count, windowStart, blockedUntil } */
const buckets = new Map();

/** 顺带做一次过期清理：Map 没有 TTL，不清就是内存泄漏。 */
function prune(now) {
    for (const [k, b] of buckets) {
        const idle = b.blockedUntil > now ? b.blockedUntil : b.windowStart + WINDOW_MS;
        if (idle <= now) buckets.delete(k);
    }
    if (buckets.size <= MAX_KEYS) return;
    // 还是太多就按「最早过期」丢，避免被伪造 IP 打爆内存
    const sorted = [...buckets.entries()].sort((a, b) => {
        const ea = Math.max(a[1].blockedUntil, a[1].windowStart + WINDOW_MS);
        const eb = Math.max(b[1].blockedUntil, b[1].windowStart + WINDOW_MS);
        return ea - eb;
    });
    for (const [k] of sorted.slice(0, buckets.size - MAX_KEYS)) buckets.delete(k);
}

/** 限流键：来源 IP + 路径族。不同路径族各算各的，免得出错一次把整站锁住。 */
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

/**
 * 查是否处于封禁中。
 * @returns {{ blocked: boolean, retryAfter: number }}
 *          retryAfter 单位秒（给 Retry-After 头用）
 */
export function checkRateLimit(key, now = Date.now()) {
    prune(now);
    const b = buckets.get(key);
    if (!b) return { blocked: false, retryAfter: 0 };
    if (b.blockedUntil > now) {
        return { blocked: true, retryAfter: Math.max(1, Math.ceil((b.blockedUntil - now) / 1000)) };
    }
    return { blocked: false, retryAfter: 0 };
}

/**
 * 记一次失败。
 * @returns {{ blocked: boolean, retryAfter: number, count: number }}
 */
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

/** 校验成功：清零该桶，别让之前输错几次影响后续正常使用 */
export function noteSuccess(key) {
    buckets.delete(key);
}

/** 测试用：清空全部状态 */
export function resetRateLimits() {
    buckets.clear();
}

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_FAILURES, BLOCK_MS, MAX_KEYS };
