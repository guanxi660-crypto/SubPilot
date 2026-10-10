import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConflictError } from '../src/storage.js';

const TABLES = [
    { key: 'subs', table: 'subs', id: 'name' },
    { key: 'collections', table: 'collections', id: 'name' },
    { key: 'files', table: 'files', id: 'name' },
    { key: 'converted', table: 'converted', id: 'name' },
    { key: 'templates', table: 'templates', id: 'name' },
    { key: 'shares', table: 'shares', id: 'code' },
];

const SCHEMA_VERSION = 2;

const STATS_EXTRA_ROW = '\u0000stats-extra';

function openDatabase(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);

    
    
    
    
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            app        TEXT NOT NULL,
            version    INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            settings   TEXT NOT NULL,
            rev        INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS order_index (
            collection TEXT NOT NULL PRIMARY KEY,
            ids        TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stats (
            id   TEXT NOT NULL PRIMARY KEY,
            data TEXT NOT NULL
        );
    `);
    for (const { table } of TABLES) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS ${table} (
                id   TEXT NOT NULL PRIMARY KEY,
                data TEXT NOT NULL
            );
        `);
    }

    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (current !== SCHEMA_VERSION) {
        
        
        const cols = db.prepare('PRAGMA table_info(meta)').all().map((c) => c.name);
        if (!cols.includes('rev')) {
            db.exec('ALTER TABLE meta ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
        }
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return db;
}

export function createSqliteStore(file) {
    const db = openDatabase(file);

    
    const stmtCache = new Map();
    const stmt = (sql) => {
        let s = stmtCache.get(sql);
        if (!s) {
            s = db.prepare(sql);
            stmtCache.set(sql, s);
        }
        return s;
    };

    
    
    
    
    let snapshotCache = null;
    let rowCache = null;
    let orderCache = null;
    let statsCache = null;
    let statsRowCache = null;
    
    
    let statsExtraJson = null;

    function hydrate() {
        if (rowCache) return;
        rowCache = {};
        orderCache = {};
        snapshotCache = { app: 'SubPilot', version: 1, updatedAt: '' };

        for (const { key, table, id: idField } of TABLES) {
            const rows = stmt(`SELECT id, data FROM ${table}`).all();
            const byId = new Map();
            for (const r of rows) byId.set(r.id, r.data);
            rowCache[key] = byId;

            const orderRow = stmt('SELECT ids FROM order_index WHERE collection = ?').get(key);
            let ids = [];
            if (orderRow) {
                try {
                    const parsed = JSON.parse(orderRow.ids);
                    if (Array.isArray(parsed)) ids = parsed;
                } catch {
                    
                    
                    ids = [];
                }
            }
            const list = [];
            const listed = new Set();
            for (const id of ids) {
                const data = byId.get(id);
                if (data === undefined) continue; 
                list.push(JSON.parse(data));
                listed.add(id);
            }
            
            for (const [id, data] of byId) {
                if (listed.has(id)) continue;
                list.push(JSON.parse(data));
            }

            orderCache[key] = list.map((row) => String(row[idField] ?? ''));
            snapshotCache[key] = list;
            
            
            
            
            
            
            rowCache[key] = byId;
        }

        const meta = stmt('SELECT app, version, rev, updated_at, settings FROM meta WHERE id = 1').get();
        if (meta) {
            snapshotCache.app = meta.app;
            snapshotCache.version = meta.version;
            
            
            snapshotCache.rev = Number(meta.rev) || 0;
            snapshotCache.updatedAt = meta.updated_at;
            snapshotCache.settings = JSON.parse(meta.settings);
        }
    }

    function hydrateStats() {
        if (statsRowCache) return;
        statsRowCache = new Map();
        const items = {};
        let extra = {};
        for (const r of stmt('SELECT id, data FROM stats').all()) {
            if (r.id === STATS_EXTRA_ROW) {
                try {
                    const parsed = JSON.parse(r.data);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed;
                } catch {
                    
                }
                continue;
            }
            statsRowCache.set(r.id, r.data);
            items[r.id] = JSON.parse(r.data);
        }
        statsExtraJson = JSON.stringify(extra);
        statsCache = { ...extra, items };
    }

    
    function planTable(idField, list, prevRows, prevIds) {
        const nextRows = new Map();
        const nextIds = [];
        for (const row of list) {
            const id = String(row?.[idField] ?? '');
            if (!id) continue; 
            nextRows.set(id, JSON.stringify(row));
            nextIds.push(id);
        }

        const upserts = [];
        for (const [id, json] of nextRows) {
            if (prevRows.get(id) !== json) upserts.push([id, json]);
        }
        const deletes = [];
        for (const id of prevRows.keys()) if (!nextRows.has(id)) deletes.push(id);

        
        const orderChanged = prevIds.join('\u0000') !== nextIds.join('\u0000');

        return { nextRows, nextIds, upserts, deletes, orderChanged };
    }

    
    function tx(fn) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const r = fn();
            db.exec('COMMIT');
            return r;
        } catch (e) {
            try {
                db.exec('ROLLBACK');
            } catch {
                
            }
            throw e;
        }
    }

    return {
        async readSnapshot() {
            hydrate();
            return structuredClone(snapshotCache);
        },

        
        async writeSnapshot(snap, { expectedRev } = {}) {
            hydrate();
            const plans = TABLES.map(({ key, table, id }) => ({
                key,
                table,
                plan: planTable(
                    id,
                    Array.isArray(snap[key]) ? snap[key] : [],
                    rowCache[key],
                    orderCache[key],
                ),
            }));

            tx(() => {
                if (expectedRev !== undefined) {
                    
                    
                    const row = stmt('SELECT rev FROM meta WHERE id = 1').get();
                    const currentRev = row ? Number(row.rev) || 0 : 0;
                    if (currentRev !== Number(expectedRev)) {
                        throw new ConflictError(
                            `快照已被其他写入更新（期望 rev=${expectedRev}，实际 rev=${currentRev}）`,
                        );
                    }
                }
                for (const { key, table, plan } of plans) {
                    for (const [id, json] of plan.upserts) {
                        stmt(
                            `INSERT INTO ${table} (id, data) VALUES (?, ?)
                             ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
                        ).run(id, json);
                    }
                    for (const id of plan.deletes) stmt(`DELETE FROM ${table} WHERE id = ?`).run(id);
                    if (plan.orderChanged || plan.upserts.length || plan.deletes.length) {
                        stmt(
                            `INSERT INTO order_index (collection, ids) VALUES (?, ?)
                             ON CONFLICT(collection) DO UPDATE SET ids = excluded.ids`,
                        ).run(key, JSON.stringify(plan.nextIds));
                    }
                }

                stmt(
                    `INSERT INTO meta (id, app, version, updated_at, settings, rev)
                     VALUES (1, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                        app = excluded.app, version = excluded.version,
                        updated_at = excluded.updated_at, settings = excluded.settings,
                        rev = excluded.rev`,
                ).run(
                    String(snap.app || 'SubPilot'),
                    Number(snap.version) || 1,
                    String(snap.updatedAt || ''),
                    JSON.stringify(snap.settings ?? {}),
                    Number(snap.rev) || 0,
                );
            });

            for (const { key, plan } of plans) {
                rowCache[key] = plan.nextRows;
                orderCache[key] = plan.nextIds;
            }
            
            
            snapshotCache = structuredClone(snap);
        },

        async readStats() {
            hydrateStats();
            return structuredClone(statsCache);
        },

        async writeStats(stats) {
            hydrateStats();
            const src = stats && typeof stats === 'object' ? stats : {};
            const items = src.items && typeof src.items === 'object' ? src.items : {};
            const next = new Map();
            for (const [k, v] of Object.entries(items)) next.set(k, JSON.stringify(v));

            
            const extra = {};
            for (const [k, v] of Object.entries(src)) if (k !== 'items') extra[k] = v;
            const extraJson = JSON.stringify(extra);
            const extraChanged = statsExtraJson !== extraJson;

            const upserts = [];
            for (const [k, json] of next) if (statsRowCache.get(k) !== json) upserts.push([k, json]);
            const deletes = [];
            for (const k of statsRowCache.keys()) if (!next.has(k)) deletes.push(k);

            if (upserts.length || deletes.length || extraChanged) {
                tx(() => {
                    for (const [k, json] of upserts) {
                        stmt(
                            `INSERT INTO stats (id, data) VALUES (?, ?)
                             ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
                        ).run(k, json);
                    }
                    for (const k of deletes) stmt('DELETE FROM stats WHERE id = ?').run(k);
                    if (extraChanged) {
                        stmt(
                            `INSERT INTO stats (id, data) VALUES (?, ?)
                             ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
                        ).run(STATS_EXTRA_ROW, extraJson);
                    }
                });
            }
            statsRowCache = next;
            statsExtraJson = extraJson;
            statsCache = structuredClone({ ...extra, items });
        },

        
        checkpoint() {
            try {
                db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            } catch {
                
            }
        },

        close() {
            try {
                db.close();
            } catch {
                
            }
        },
    };
}
