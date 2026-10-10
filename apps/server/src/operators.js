import { renameNode, regionOf, flagOf, REGIONS } from './nodes.js';
import { isPlainObject } from './util.js';

const MAX_NODES = 20000;

function buildRegex(pattern, fallbackFlags = '') {
    let p = String(pattern ?? '');
    let flags = fallbackFlags;
    const m = p.match(/^\(\?([a-z]+)\)/i);
    if (m) {
        if (m[1].includes('i')) flags += 'i';
        if (m[1].includes('m')) flags += 'm';
        p = p.slice(m[0].length);
    }
    flags = [...new Set(flags.split(''))].join('');
    return new RegExp(p, flags);
}

function asArray(v) {
    if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x !== '');
    if (v === undefined || v === null || v === '') return [];
    return [String(v)];
}

const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const EMOJI_GLOBAL_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

function typeOf(n) {
    return String(n.type || '').toLowerCase();
}

function pickStr(s, patterns, modes) {
    
    for (const p of patterns) {
        try {
            if (buildRegex(p).test(s)) return true;
        } catch {
            
        }
    }
    return false;
}

const HANDLERS = {
    
    'Regex Filter'(nodes, args) {
        const patterns = asArray(args.regex);
        const mode = args.mode === 'exclude' ? 'exclude' : 'keep';
        if (!patterns.length) return nodes;
        return nodes.filter((n) => {
            const hit = pickStr(n.name, patterns);
            return mode === 'keep' ? hit : !hit;
        });
    },

    
    'Region Filter'(nodes, args) {
        const want = asArray(args.regions).map((s) => s.toUpperCase());
        const mode = args.mode === 'exclude' ? 'exclude' : 'keep';
        if (!want.length) return nodes;
        return nodes.filter((n) => {
            const code = regionOf(n.name);
            const hit = code && want.includes(code);
            return mode === 'keep' ? hit : !hit;
        });
    },

    
    'Type Filter'(nodes, args) {
        const want = asArray(args.types).map((s) => s.toLowerCase());
        const mode = args.mode === 'exclude' ? 'exclude' : 'keep';
        if (!want.length) return nodes;
        return nodes.filter((n) => {
            const hit = want.includes(typeOf(n));
            return mode === 'keep' ? hit : !hit;
        });
    },

    
    'Useless Filter'(nodes) {
        return nodes.filter((n) => {
            if (!n.server) return false;
            if (!n.port) return false;
            if (/(剩余|到期|过期|官网|订阅|流量|重置|客服|购买|续费|群组|telegram|t\.me)/i.test(n.name)) {
                return false;
            }
            return true;
        });
    },

    
    'Regex Rename'(nodes, args) {
        
        
        
        
        
        const pairs = Array.isArray(args.regex) ? args.regex.map((x) => String(x ?? '')) : [];
        for (let i = 0; i + 1 < pairs.length; i += 2) {
            const re = pairs[i];
            
            if (!re) continue;
            const repl = pairs[i + 1];
            for (const n of nodes) {
                try {
                    const next = n.name.replace(buildRegex(re, 'g'), repl);
                    if (next !== n.name) renameNode(n, next);
                } catch {
                    
                }
            }
        }
        return nodes;
    },

    
    'Regex Delete'(nodes, args) {
        const patterns = asArray(args.regex);
        for (const n of nodes) {
            let name = n.name;
            for (const p of patterns) {
                try {
                    name = name.replace(buildRegex(p, 'g'), '');
                } catch {
                    
                }
            }
            name = name.replace(/\s{2,}/g, ' ').trim();
            if (name && name !== n.name) renameNode(n, name);
        }
        return nodes;
    },

    
    'Name Prefix'(nodes, args) {
        const v = String(args.value ?? '');
        if (!v) return nodes;
        for (const n of nodes) renameNode(n, v + n.name);
        return nodes;
    },
    'Name Suffix'(nodes, args) {
        const v = String(args.value ?? '');
        if (!v) return nodes;
        for (const n of nodes) renameNode(n, n.name + v);
        return nodes;
    },

    
    'Sort Operator'(nodes, args) {
        const by = String(args.by || 'name');
        const dir = args.sort === 'desc' ? -1 : 1;
        const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
        const key = (n) => {
            if (by === 'type') return typeOf(n);
            if (by === 'server') return n.server || '';
            if (by === 'region') {
                const c = regionOf(n.name);
                const idx = REGIONS.findIndex((r) => r.code === c);
                
                return idx < 0 ? 'zz' : String(idx).padStart(3, '0');
            }
            return n.name || '';
        };
        const sorted = [...nodes].sort((a, b) => {
            const ka = key(a);
            const kb = key(b);
            const r = typeof ka === 'number' ? ka - kb : collator.compare(ka, kb);
            return r !== 0 ? r * dir : 0;
        });
        return sorted;
    },

    
    'Region Pin'(nodes, args) {
        const want = asArray(args.regions).map((s) => s.toUpperCase());
        if (!want.length) return nodes;
        const pos = args.position === 'bottom' ? 'bottom' : 'top';
        const rank = new Map(want.map((c, i) => [c, i]));
        const hit = [];
        const rest = [];
        for (const n of nodes) {
            const code = regionOf(n.name);
            (code && rank.has(code) ? hit : rest).push(n);
        }
        
        
        hit.sort((a, b) => rank.get(regionOf(a.name)) - rank.get(regionOf(b.name)));
        return pos === 'top' ? [...hit, ...rest] : [...rest, ...hit];
    },

    
    'Keyword Sort'(nodes, args) {
        const kws = asArray(args.keywords).map((k) => k.toLowerCase()).filter(Boolean);
        if (!kws.length) return nodes;
        const unmatched = args.unmatched === 'top' ? 'top' : 'bottom';
        const rank = new Map();
        for (const n of nodes) {
            const name = String(n.name || '').toLowerCase();
            let best = Infinity;
            for (let i = 0; i < kws.length; i++) {
                
                if (i < best && name.includes(kws[i])) best = i;
            }
            rank.set(n, best);
        }
        const hit = [];
        const rest = [];
        for (const n of nodes) (rank.get(n) < Infinity ? hit : rest).push(n);
        
        hit.sort((a, b) => rank.get(a) - rank.get(b));
        return unmatched === 'top' ? [...rest, ...hit] : [...hit, ...rest];
    },

    
    'Handle Duplicate'(nodes, args) {
        const action = args.action === 'delete' ? 'delete' : 'rename';
        const seen = new Map();
        const out = [];
        for (const n of nodes) {
            const c = seen.get(n.name) || 0;
            if (c === 0) {
                seen.set(n.name, 1);
                out.push(n);
                continue;
            }
            if (action === 'delete') continue;
            let candidate = `${n.name} ${c + 1}`;
            let k = c + 1;
            while (seen.has(candidate)) {
                k += 1;
                candidate = `${n.name} ${k}`;
            }
            seen.set(n.name, k);
            seen.set(candidate, 1);
            renameNode(n, candidate);
            out.push(n);
        }
        return out;
    },

    
    'Flag Operator'(nodes, args) {
        const mode = args.mode === 'remove' ? 'remove' : 'add';
        for (const n of nodes) {
            if (mode === 'remove') {
                const next = n.name.replace(EMOJI_GLOBAL_RE, '').replace(/\s{2,}/g, ' ').trim();
                if (next && next !== n.name) renameNode(n, next);
                continue;
            }
            if (EMOJI_RE.test(n.name)) continue;
            const flag = flagOf(regionOf(n.name));
            if (flag) renameNode(n, `${flag} ${n.name}`);
        }
        return nodes;
    },

    
    'Limit Operator'(nodes, args) {
        const limit = Math.max(0, parseInt(args.limit, 10) || 0);
        if (!limit) return nodes;
        return args.from === 'tail' ? nodes.slice(-limit) : nodes.slice(0, limit);
    },

    
    'Quick Settings'(nodes, args, log) {
        const keys = ['udp', 'tfo', 'skip-cert-verify'];
        const want = {};
        for (const k of keys) if (typeof args[k] === 'boolean') want[k] = args[k];
        if (!Object.keys(want).length) return nodes;

        let touched = 0;
        let skipped = 0;
        for (const n of nodes) {
            if (n.format !== 'clash' || !n.obj) {
                skipped += 1;
                continue;
            }
            for (const [k, v] of Object.entries(want)) n.obj[k] = v;
            touched += 1;
        }
        if (skipped) {
            log.push(
                `Quick Settings：${touched} 个 Clash 节点已更新；${skipped} 个 URI 节点被跳过` +
                    `（URI 形态请改用转换页的 udp / tfo / scv 参数）`,
            );
        }
        return nodes;
    },
};

export function applyOperators(nodes, process) {
    const log = [];
    let cur = Array.isArray(nodes) ? nodes : [];
    if (!Array.isArray(process) || !process.length) return { nodes: cur, log };

    for (let i = 0; i < process.length; i++) {
        const op = process[i];
        const label = `#${i + 1} ${op?.type || '未命名'}`;
        if (!isPlainObject(op) || !op.type) {
            log.push(`${label}：算子格式非法，已跳过`);
            continue;
        }
        if (op.disabled) {
            log.push(`${label}：已禁用，跳过`);
            continue;
        }
        const handler = HANDLERS[op.type];
        if (!handler) {
            
            if (/script/i.test(op.type)) {
                log.push(
                    `${label}：不支持任意 JS 脚本（Workers 运行时禁 eval）。` +
                        `请改用 Regex Rename / Regex Filter / Sort Operator 等内置算子组合实现。`,
                );
            } else {
                log.push(`${label}：未知算子类型，已跳过`);
            }
            continue;
        }
        const before = cur.length;
        try {
            cur = handler(cur, isPlainObject(op.args) ? op.args : {}, log) || cur;
        } catch (e) {
            log.push(`${label}：执行出错（${e.message}），该步结果未生效`);
            continue;
        }
        if (cur.length > MAX_NODES) {
            cur = cur.slice(0, MAX_NODES);
            log.push(`${label}：节点数超过上限 ${MAX_NODES}，已截断`);
        }
        if (cur.length !== before) log.push(`${label}：${before} → ${cur.length} 个节点`);
    }
    return { nodes: cur, log };
}

export const OPERATOR_TYPES = [
    {
        type: 'Regex Filter',
        label: '正则筛选',
        icon: '⌕',
        desc: '按节点名称正则保留或排除',
        usage:
            '按节点名称做正则匹配。regex 是模式数组，可以写多条；' +
            'mode 填 keep 表示只留匹配上的，填 exclude 表示把匹配上的丢掉。' +
            '模式前加 (?i) 忽略大小写。常用写法：(?i)剩余|流量|官网 可以一次命中多个关键词。',
        args: { regex: ['(?i)剩余|流量|官网'], mode: 'exclude' },
    },
    {
        type: 'Region Filter',
        label: '地区筛选',
        icon: '🌍',
        desc: '按地区保留或排除',
        usage:
            '按地区筛选。regions 填两字母地区代码（HK 香港、TW 台湾、JP 日本、SG 新加坡、US 美国…）；' +
            'mode 填 keep 只留这些地区，填 exclude 排除这些地区。' +
            '地区是从节点名里认出来的，所以名字里带「香港」「HK」「🇭🇰」都能识别。',
        args: { regions: ['HK', 'TW', 'JP', 'SG', 'US'], mode: 'keep' },
    },
    {
        type: 'Type Filter',
        label: '协议筛选',
        icon: '⇄',
        desc: '按协议类型保留或排除',
        usage:
            '按协议类型筛选。types 用小写协议名：ss、ssr、vmess、vless、trojan、hysteria2、tuic 等；' +
            'mode 填 keep 或 exclude。想踢掉老旧协议就填 mode: exclude、types: ["ssr"]。',
        args: { types: ['ss', 'vmess', 'trojan', 'vless'], mode: 'keep' },
    },
    {
        type: 'Useless Filter',
        label: '无效节点过滤',
        icon: '⌀',
        desc: '丢掉缺字段或明显是广告信息的条目',
        usage:
            '不需要参数，填 {} 就行。会丢掉缺 server / port 等必需字段的条目，' +
            '以及名称里带「剩余流量 / 官网 / 到期时间」这类明显不是节点的条目。建议放在链首第一个。',
        args: {},
    },
    {
        type: 'Regex Rename',
        label: '正则重命名',
        icon: '✎',
        desc: '成对的「模式, 替换」，支持 $1 捕获组',
        usage:
            '改节点名。regex 是扁平数组，两两一组：第 1 个是匹配模式、第 2 个是替换文本，' +
            '后面可以继续跟第二组、第三组。替换文本里用 $1、$2 引用模式里的捕获组。' +
            '下面这个例子把「名字 | 备注」里的备注整段删掉，只留前半段。',
        args: { regex: ['^(.*?)\\s*\\|.*$', '$1'] },
    },
    {
        type: 'Regex Delete',
        label: '名称正则修剪',
        icon: '✂',
        desc: '从名称里删掉匹配片段（不删节点）',
        usage:
            '只改名字、不删节点：把名称里匹配到的片段抹掉。regex 是模式数组。' +
            '和「正则筛选」的区别是它不会让节点消失 —— 适合清理名称里多余的广告后缀。',
        args: { regex: ['(?i)\\s*\\|\\s*(剩余|官网).*'] },
    },
    {
        type: 'Name Prefix',
        label: '名称加前缀',
        icon: '⟨',
        desc: '给所有节点名加统一前缀',
        usage: '给每个节点名前面统一加一段文字。value 就是要加的内容（想留空格就把空格写进去）。',
        args: { value: '🚀 ' },
    },
    {
        type: 'Name Suffix',
        label: '名称加后缀',
        icon: '⟩',
        desc: '给所有节点名加统一后缀',
        usage: '给每个节点名后面统一加一段文字。value 就是要加的内容，常用来说明来源，比如「 · 机场A」。',
        args: { value: ' · Air' },
    },
    {
        type: 'Sort Operator',
        label: '排序',
        icon: '⇅',
        desc: '按名称 / 协议 / 服务器 / 地区排序',
        usage:
            '给节点排队。by 填 name（名称）、type（协议）、server（服务器地址）、region（地区）；' +
            'sort 填 asc 升序、desc 降序。按地区排序时港台日新美会按固定顺序排好，' +
            '客户端里的节点列表就整齐了。',
        args: { sort: 'asc', by: 'region' },
    },
    {
        type: 'Region Pin',
        label: '地区置顶',
        icon: '📌',
        desc: '把指定地区挪到列表最前（或最后），不改名',
        usage:
            '想让某些地区的节点排最前/最后时用它，**不改任何节点名**。' +
            'regions 填两字母地区代码（HK、TW、JP、SG、US…），可以多个，先填的排更前；' +
            'position 填 top（置顶）或 bottom（沉底），不填就是 top。' +
            '组内和其余节点都保持原有相对顺序。注意它和「排序」的先后：' +
            '先 Region Pin 再 Sort 会被排序盖掉，想置顶就把 Region Pin 放在 Sort 后面。',
        args: { regions: ['SG'], position: 'top' },
    },
    {
        type: 'Keyword Sort',
        label: '关键词排序',
        icon: '🔖',
        desc: '按关键词把节点分组排序，不改名',
        usage:
            '想让名字里带某些词的节点排一起、按词的先后排队时用它。' +
            'keywords 按优先级填（数组第 1 个的组排最前），名字**包含**该词（不分大小写）即入组；' +
            '同时命中多个词时归入更靠前那个词的组；' +
            'unmatched 填 bottom 表示没命中任何词的垫底、top 表示置顶（默认 bottom）。' +
            '组内保持原有相对顺序，节点名一个不动。例子：keywords: ["IEPL","IPLC","专线"] ' +
            '会把专线/极速类排最前。注意和「排序」「地区置顶」的先后：后执行的会重排整表。',
        args: { keywords: ['IEPL', 'IPLC', '专线'], unmatched: 'bottom' },
    },
    {
        type: 'Handle Duplicate',
        label: '去重处理',
        icon: '⧉',
        desc: '重名节点加序号或直接删除',
        usage:
            '重名节点怎么处理：action 填 rename 会自动加序号（香港 1、香港 2），' +
            '填 delete 则只保留第一个、其余丢掉。' +
            '订阅里有多个同名节点时，客户端会分不清，加序号更安全。',
        args: { action: 'rename' },
    },
    {
        type: 'Flag Operator',
        label: '国旗标识',
        icon: '🏳',
        desc: '按地区自动加国旗 emoji',
        usage:
            '按地区给节点名加上国旗 emoji。mode 填 add 添加国旗、填 remove 去掉已有的国旗。' +
            '配合「排序（按地区）」用，列表一眼就能看出哪个是哪个区。',
        args: { mode: 'add' },
    },
    {
        type: 'Limit Operator',
        label: '数量截断',
        icon: '✂',
        desc: '只保留前 N 个（或后 N 个）节点',
        usage:
            '控制节点总数。limit 填保留几个；from 填 head 表示保留最前面 N 个、' +
            '填 tail 表示保留最后 N 个。放在「排序」之后效果最好 —— 先排好序再截断，' +
            '留下的就是质量最高那批。',
        args: { limit: 100, from: 'head' },
    },
    {
        type: 'Quick Settings',
        label: '快速设置',
        icon: '⚙',
        desc: '批量改 UDP / TFO / 跳过证书验证（仅 Clash 形态）',
        usage:
            '批量给所有节点改参数，只对 Clash 形态的产出生效。' +
            '可填 udp、tfo、skip-cert-verify 等布尔项，写进去的就是要改成的值，' +
            '没写的字段保持原样。不确定就别开 skip-cert-verify，会降低安全性。',
        args: { udp: true },
    },
];

export const PROCESS_PRESETS = [
    {
        name: '一键整理（推荐）',
        desc: '无效过滤 → 去广告 → 削机场前缀 → 去重 → 按地区排序 → 加国旗',
        process: [
            { type: 'Useless Filter', args: {} },
            { type: 'Regex Filter', args: { regex: ['(?i)剩余|流量|到期|过期|官网|订阅|续费|客服|群组'], mode: 'exclude' } },
            { type: 'Regex Delete', args: { regex: ['(?i)\\s*[|｜]\\s*(剩余|流量|官网).*$'] } },
            
            { type: 'Regex Rename', args: { regex: ['^[^|｜]*[|｜]\\s*', '', '\\s{2,}', ' '] } },
            { type: 'Handle Duplicate', args: { action: 'rename' } },
            { type: 'Sort Operator', args: { sort: 'asc', by: 'region' } },
            { type: 'Flag Operator', args: { mode: 'add' } },
        ],
    },
];
