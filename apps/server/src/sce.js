// SubConverter-Extended 客户端。
//
// 本项目**不实现格式转换**，转换全部委托给 SCE 的 `/sub`。
// 这一层负责两件事：
//   ① 把内部参数拼成合法的 SCE 查询串（白名单过滤，避免把内部参数漏出去）
//   ② 带上超时与错误转译，把 SCE 的纯文本报错包装成可读信息
//
// 参数名严格对齐 SCE Wiki 的「API 参考」，不自行发明拼写。

export const DEFAULT_SCE = 'https://subpilot.57995799.xyz';

/** 允许透传给 SCE 的参数（其余一律丢弃） */
const PASS_THROUGH = [
    'target', 'url', 'config', 'group', 'filename', 'ver', 'interval', 'strict',
    'dev_id', 'upload', 'upload_path', 'append_info',
    'include', 'exclude', 'rename',
    'emoji', 'add_emoji', 'remove_emoji', 'append_type', 'sort', 'sort_script', 'fdn',
    'udp', 'tfo', 'scv', 'tls13', 'new_name',
    'list', 'script', 'expand', 'classic', 'insert', 'prepend',
    'provider_proxy_direct', 'provider_headers', 'explain',
];

/**
 * 布尔语义的参数。
 * 取值由 normalizeBool 归一：true/1/yes/on → "true"，false/0/no/off → "false"，
 * 其余一律**丢弃**（不传给 SCE）。宽松接受 yes/on 是因为手写 URL 时很容易这么写，
 * 与其让它变成 SCE 侧的「无法识别的参数」，不如在这里就归一掉。
 */
const BOOLEAN_PARAMS = new Set([
    'strict', 'upload', 'append_info', 'emoji', 'add_emoji', 'remove_emoji',
    'append_type', 'sort', 'sort_script', 'fdn', 'udp', 'tfo', 'scv', 'tls13',
    'new_name', 'list', 'script', 'expand', 'classic', 'insert', 'prepend',
    'provider_proxy_direct', 'explain',
]);

/**
 * SCE 的显式目标格式（Wiki「当前 Release 目标格式」）。
 *
 * 2026-10-09 按 `docs/目标格式体检报告.md` 做过一次裁剪：用一份真实订阅逐格式实测，
 * 只保留「能稳定拿到完整节点」的格式。已下线的 12 项及原因：
 *   clashr / surge / quanx / loon / surfboard / stash —— 均为「客户端自拉」模式，
 *     结果体里本就不含节点，且实测出短板（surge 远程资源段异常、stash 直接 400、
 *     quanx 不生成远程资源段），对普通用户是纯噪声；
 *   quan / mellow —— 配置型转换，实测只出 1 个节点，形同废格式；
 *   v2rayn / v2rayng —— 与 shadowrocket 高度重叠，且会丢后量子加密 vless 节点；
 *   ssd / sssub —— 与 ss / ssr 重叠，无独立价值。
 * 若后续 SCE 上游修好这些格式，可参考报告里的对照实验方式重新评估后加回。
 *
 * v2ray（base64）与 mixed（base64）更早已移除：
 * v2ray 通用订阅改走本站 raw 通道（/sub?target=raw，不依赖 SCE），见 convert.js。
 */
export const SCE_TARGETS = [
    { value: 'clash', label: 'Clash / Mihomo', group: 'Mihomo Provider' },
    { value: 'singbox', label: 'sing-box', group: '完整配置转换' },
    { value: 'shadowrocket', label: 'Shadowrocket', group: '简单订阅输出' },
    { value: 'trojan', label: 'Trojan', group: '简单订阅输出' },
    { value: 'vless', label: 'VLESS', group: '简单订阅输出' },
    { value: 'hysteria2', label: 'Hysteria2', group: '简单订阅输出' },
    { value: 'ss', label: 'SS', group: '简单订阅输出' },
    { value: 'ssr', label: 'SSR', group: '简单订阅输出' },
];

/**
 * 已从 UI 下线的目标格式（同上那批裁剪掉的）。
 *
 * 为什么要留着而不是删干净：这些 target 值**可能已经存在于用户的历史数据里** ——
 * TG 推送配置的 `linkType`、已保存成品的 `target`、别人手里已经发出去的订阅链接。
 * 如果校验直接按 SCE_TARGETS 走，老用户下次保存 TG 配置就会撞「不支持的链接类型」，
 * 属于纯 bug。所以这里保留「值 → 显示名」的映射：**能通过校验、显示得出名字**，
 * 只是不再出现在任何下拉里。SCE 侧本身也仍然支持这些 target，老链接照常可用。
 */
const LEGACY_TARGETS = [
    // 2026-10-09 裁剪掉的 12 项
    { value: 'clashr', label: 'ClashR' },
    { value: 'surge', label: 'Surge' },
    { value: 'quanx', label: 'Quantumult X' },
    { value: 'loon', label: 'Loon' },
    { value: 'surfboard', label: 'Surfboard' },
    { value: 'stash', label: 'Stash' },
    { value: 'quan', label: 'Quantumult' },
    { value: 'mellow', label: 'Mellow' },
    { value: 'v2rayn', label: 'v2rayN' },
    { value: 'v2rayng', label: 'v2rayNG' },
    { value: 'ssd', label: 'SSD' },
    { value: 'sssub', label: 'SSSub' },
    // 更早一批（v2ray 通用订阅改走本站 raw 通道时）下线的两项。
    // 一并补进来：当年那次裁剪同样会让存过这两个值的老配置保存失败。
    { value: 'v2ray', label: 'v2ray' },
    { value: 'mixed', label: 'Mixed' },
];

/**
 * 值 → 显示名的**全量**映射（含已下线项），供「校验合法性」和「展示链接类型」使用。
 * 注意与 SCE_TARGETS 的区别：那个是 UI 下拉清单，这个是兼容性白名单。
 */
export const TARGET_LABEL = Object.fromEntries(
    [...SCE_TARGETS, ...LEGACY_TARGETS].map((t) => [t.value, t.label]),
);

/** 解析实际使用的后端地址 */
export function resolveBackend(env, settings) {
    const s = String(settings?.subBackend || env?.SUB_BACKEND || '').trim();
    const base = s || DEFAULT_SCE;
    return base.replace(/\/+$/, '');
}

function normalizeBool(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    const s = String(v).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return 'true';
    if (['false', '0', 'no', 'off'].includes(s)) return 'false';
    return '';
}

/**
 * 用白名单参数拼出 SCE 的 /sub 查询串。
 * @param {object} params 内部参数（多出来的键会被丢弃）
 */
export function buildSceQuery(params) {
    const qs = new URLSearchParams();
    for (const key of PASS_THROUGH) {
        const v = params[key];
        if (v === undefined || v === null || v === '') continue;
        if (BOOLEAN_PARAMS.has(key)) {
            const b = normalizeBool(v);
            if (b) qs.set(key, b);
            continue;
        }
        qs.set(key, String(v));
    }
    return qs.toString();
}

export function buildSceUrl(base, params) {
    return `${base.replace(/\/+$/, '')}/sub?${buildSceQuery(params)}`;
}

/**
 * 调用 SCE 的 /sub。
 * @returns {Promise<Response>} 原始 Response（转换结果可能是 YAML / JSON / base64 文本，
 *          这里不做解析，交给上层按需处理）
 */
export async function callSce(base, params, { timeoutMs = 20000, extraHeaders = {}, method = 'GET' } = {}) {
    const url = buildSceUrl(base, params);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                // SCE 会按 UA 做目标自动识别（target=auto），这里明确声明是订阅客户端
                'User-Agent': 'clash-verge/v2.0 SubPilot/0.1',
                Accept: '*/*',
                ...extraHeaders,
            },
            signal: ctrl.signal,
            redirect: 'follow',
        });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 探测后端身份：GET /version。
 * SCE 的 /version 返回的是 HTML 页面，不是 JSON，所以这里做宽松提取：
 * 先找形如 v1.2.3 的版本号，找不到就标记为在线但版本未知。
 */
export async function probeBackend(base, { timeoutMs = 8000 } = {}) {
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) return { online: false, version: '', error: '未配置转换后端' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`${root}/version`, {
            headers: { Accept: 'text/html,application/json,*/*' },
            signal: ctrl.signal,
        });
        const body = await res.text();
        if (!res.ok) {
            return { online: false, version: '', error: `后端返回 HTTP ${res.status}` };
        }
        let version = '';
        // JSON 形态（部分部署会开 API 输出）
        try {
            const j = JSON.parse(body);
            version = j.version || j.release || j.tag || '';
        } catch {
            /* 不是 JSON，走 HTML 提取 */
        }
        if (!version) {
            const m =
                body.match(/v\d+\.\d+\.\d+[-\w.]*/) ||
                body.match(/"(?:version|tag|release)"\s*:\s*"([^"]+)"/i) ||
                body.match(/<title>([^<]{0,80})<\/title>/i);
            version = m ? (m[1] || m[0]).trim() : '';
        }
        return { online: true, version, error: '' };
    } catch (e) {
        const msg = e.name === 'AbortError' ? '探测超时' : e.message || String(e);
        return { online: false, version: '', error: msg };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 把 SCE 的错误响应转成人类可读的一句话。
 * SCE 的报错正文是中英双语纯文本，原样带出来比「HTTP 400」有用得多。
 */
export function describeSceError(status, body) {
    const clean = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) return `转换后端返回 HTTP ${status}`;
    return `转换后端返回 HTTP ${status}：${clean}`;
}
