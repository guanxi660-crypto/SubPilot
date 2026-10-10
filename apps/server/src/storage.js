import { isPlainObject, nowIso } from './util.js';

const SNAPSHOT_KEY = 'panel:snapshot:v1';
const STATS_KEY = 'panel:stats:v1';

function kvDriver(DATA) {
    return {
        async readSnapshot() {
            return await DATA.get(SNAPSHOT_KEY, 'json');
        },
        async writeSnapshot(snap) {
            await DATA.put(SNAPSHOT_KEY, JSON.stringify(snap));
        },
        async readStats() {
            return await DATA.get(STATS_KEY, 'json');
        },
        async writeStats(stats) {
            await DATA.put(STATS_KEY, JSON.stringify(stats));
        },
    };
}

function driverOf(env) {
    return env.STORE || kvDriver(env.DATA);
}

export function defaultSettings() {
    return {
        
        subBackend: '',
        
        publicBaseUrl: '',
        
        defaultTarget: 'clash',
        defaultConfig: '',
        
        feedSalt: '',
        feedSaltCreatedAt: '',
        
        ai: { baseUrl: '', model: '', apiKey: '' },
        
        sync: {
            provider: 'none', 
            gist: { token: '', gistId: '' },
            webdav: { url: '', user: '', pass: '', dir: '' },
        },
        
        telegram: {
            token: '',
            chatIds: '',
            targets: [], 
            linkType: '', 
            autoPush: false,
            lastPush: null,
        },
    };
}

export function defaultSnapshot() {
    return {
        app: 'SubPilot',
        version: 1,
        
        
        
        rev: 0,
        subs: [],
        collections: [],
        files: [],
        converted: [],
        shares: [],
        
        
        templates: [],
        settings: defaultSettings(),
        updatedAt: nowIso(),
    };
}

export async function loadSnapshot(env) {
    try {
        const raw = await driverOf(env).readSnapshot();
        if (!isPlainObject(raw)) return defaultSnapshot();
        return normalizeSnapshot(raw);
    } catch {
        return defaultSnapshot();
    }
}

export class ConflictError extends Error {
    constructor(message = '数据在本次操作期间被其他写入修改，请重试') {
        super(message);
        this.name = 'ConflictError';
        this.status = 409;
        this.expose = true;
    }
}

export async function saveSnapshot(env, snap, { expectedRev } = {}) {
    snap.updatedAt = nowIso();
    snap.rev = (Number(snap.rev) || 0) + 1;
    await driverOf(env).writeSnapshot(snap, { expectedRev });
    return snap;
}

let mutateChain = Promise.resolve();

const MAX_WRITE_RETRY = 1;

export async function mutate(env, fn) {
    const run = async () => {
        for (let attempt = 0; ; attempt++) {
            const snap = await loadSnapshot(env);
            const baseRev = Number(snap.rev) || 0;
            const result = await fn(snap);
            try {
                await saveSnapshot(env, snap, { expectedRev: baseRev });
                return { snap, result };
            } catch (e) {
                if (e?.name !== 'ConflictError' || attempt >= MAX_WRITE_RETRY) throw e;
            }
        }
    };
    
    const next = mutateChain.then(run, run);
    mutateChain = next.then(
        () => {},
        () => {},
    );
    return next;
}

function normalizeSnapshot(raw) {
    const base = defaultSnapshot();
    const out = { ...base, ...raw };
    for (const k of ['subs', 'collections', 'files', 'converted', 'shares', 'templates']) {
        if (!Array.isArray(out[k])) out[k] = [];
    }
    
    out.rev = Number.isFinite(Number(out.rev)) ? Number(out.rev) : 0;
    out.settings = { ...defaultSettings(), ...(isPlainObject(raw.settings) ? raw.settings : {}) };
    out.settings.ai = { ...defaultSettings().ai, ...(raw.settings?.ai || {}) };
    out.settings.sync = { ...defaultSettings().sync, ...(raw.settings?.sync || {}) };
    out.settings.sync.gist = {
        ...defaultSettings().sync.gist,
        ...(raw.settings?.sync?.gist || {}),
    };
    out.settings.sync.webdav = {
        ...defaultSettings().sync.webdav,
        ...(raw.settings?.sync?.webdav || {}),
    };
    out.settings.telegram = {
        ...defaultSettings().telegram,
        ...(raw.settings?.telegram || {}),
    };
    if (!Array.isArray(out.settings.telegram.targets)) out.settings.telegram.targets = [];
    return out;
}

export const MAX_STATS_ITEMS = 5000;

const STATS_LOW_WATER = 4500;

export async function loadStats(env) {
    try {
        const raw = await driverOf(env).readStats();
        if (!isPlainObject(raw) || !isPlainObject(raw.items)) return { items: {} };
        return raw;
    } catch {
        return { items: {} };
    }
}

let statsChain = Promise.resolve();

export async function recordPull(env, { type, item, ip }) {
    const run = async () => {
        const stats = await loadStats(env);
        const key = `${type}|${item}|${ip}`;
        const cur = stats.items[key] || { type, item, ip, count: 0, last: '' };
        cur.count += 1;
        cur.last = nowIso();
        stats.items[key] = cur;

        
        
        
        const keys = Object.keys(stats.items);
        if (keys.length > MAX_STATS_ITEMS) {
            const oldestFirst = keys
                .map((k) => [k, String(stats.items[k]?.last || '')])
                .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
            const dropCount = keys.length - STATS_LOW_WATER;
            for (let i = 0; i < dropCount; i++) delete stats.items[oldestFirst[i][0]];
            stats.dropped = (Number(stats.dropped) || 0) + dropCount;
        }

        try {
            await driverOf(env).writeStats(stats);
        } catch (e) {
            
            
            
            console.warn(`[stats] 写入失败，本次计数已丢弃：${e?.message || e}`);
            throw e;
        }
        return cur;
    };
    
    const next = statsChain.then(run, run);
    statsChain = next.catch(() => {});
    return next;
}

export async function clearStats(env) {
    await driverOf(env).writeStats({ items: {} });
}
