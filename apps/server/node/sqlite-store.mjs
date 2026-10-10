// SQLite 存储驱动 —— Node / Docker 部署用（Cloudflare 那边仍然走 KV）。
//
// 为什么换掉原先「一个 key 一个 JSON 文件」的实现：
//   1. **写入量**：原来改一条订阅，要把整个快照（含所有订阅正文，可能几 MB）
//      重新序列化再整份落盘。现在按行 diff，只有真正变化的行才写。
//   2. **原子性**：文件方案靠「写临时文件再 rename」防半截 JSON，但一次业务
//      操作往往要同时改 subs / collections / shares 好几张表，中间被杀掉就会
//      留下一致性裂缝。SQLite 一个事务全包。
//   3. **并发**：WAL 模式下读写可以并行；synchronous=NORMAL 不再每个事务都 fsync。
//
// 为什么用 node:sqlite 而不是 better-sqlite3：
//   Node 22.5+ 内置 node:sqlite（22 / 24 上都不需要命令行 flag），省掉一个原生
//   依赖 —— alpine 镜像里不用再装 python / make / g++ 去编译，镜像更小、构建更快。
//   DatabaseSync 是**同步** API，单用户面板的写入量下这反而是优点：没有异步开销，
//   也不存在同一进程内的写-写交错。
//
// ⚠️ 一个必须记住的 SQLite 性质：**一行记录是一个整体**。TEXT 列再大，只要改了
// 这一行的任何一列，SQLite 就要把整条记录（含正文、含溢出页）重写一遍。所以
// 「顺序」不能和正文放在同一张表里 —— 否则「新增订阅插到最前」会让所有订阅的
// 顺序字段都变，进而把所有正文重写一遍，优化就白做了。
// 因此顺序单独存一行：order_index(collection, ids)，ids 是 id 的 JSON 数组。
// 插入 / 删除 / 重排只改这一个几 KB 的小行，正文一行都不动。
//
// 与 storage.js 的契约（4 个方法，见那边注释）：
//   readSnapshot() / writeSnapshot(snap) / readStats() / writeStats(stats)
//
// ⚠️ 返回的都是**深拷贝**。因为调用方（mutate 的回调）会原地修改快照，若直接把
// 缓存对象交出去，缓存会被改脏 —— 下一次 diff 就会认为「什么都没变」，更新静默
// 丢失。structuredClone 是原生实现，比 JSON 往返快得多。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConflictError } from '../src/storage.js';

/**
 * 各集合的落表配置。
 * 主键字段的选择依据：subs / collections / files / converted / templates 的名称
 * 在各自集合内唯一（API 层强制）；shares 允许多条同名分享码，唯一的是 code。
 */
const TABLES = [
    { key: 'subs', table: 'subs', id: 'name' },
    { key: 'collections', table: 'collections', id: 'name' },
    { key: 'files', table: 'files', id: 'name' },
    { key: 'converted', table: 'converted', id: 'name' },
    { key: 'templates', table: 'templates', id: 'name' },
    { key: 'shares', table: 'shares', id: 'code' },
];

// v1 → v2：meta 增加 rev 列（快照写次数，用于跨进程写冲突检测，见 storage.js 的
// ConflictError）。旧库在 openDatabase 里按列存在性补 ALTER，不会丢数据。
const SCHEMA_VERSION = 2;

/**
 * stats 表里存放「items 之外顶层字段」的保留行 id。
 * 用一个含 NUL 的串：正常的统计 key 是 `类型|项目|IP`，不可能撞上它。
 */
const STATS_EXTRA_ROW = '\u0000stats-extra';

function openDatabase(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);

    // WAL：读写不互相阻塞，且提交只需追加日志。
    // synchronous=NORMAL：WAL 下不每个事务 fsync，崩溃最多丢最后一个事务 ——
    // 对面板数据完全可接受，换来的是写入快一个数量级。
    // busy_timeout：多进程（比如你同时开着备份脚本）时不立刻报 SQLITE_BUSY。
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
        // v1 的库没有 meta.rev。新建库在上面 CREATE TABLE 里已经带上了这一列，
        // 所以 ALTER 必须先探列、不能无脑执行（否则 "duplicate column name"）。
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

    // 预编译语句缓存。prepare 有固定开销，而写入是热路径，别每次重建。
    const stmtCache = new Map();
    const stmt = (sql) => {
        let s = stmtCache.get(sql);
        if (!s) {
            s = db.prepare(sql);
            stmtCache.set(sql, s);
        }
        return s;
    };

    // 上次落库的形态，用来算最小 diff：
    //   rowCache[key]   = Map(id → json)
    //   orderCache[key] = id 数组
    // null 表示尚未加载（冷启动），首次访问时从库里回填。
    let snapshotCache = null;
    let rowCache = null;
    let orderCache = null;
    let statsCache = null;
    let statsRowCache = null;
    // stats 表里 items 之外的顶层字段（目前只有 dropped —— 统计轮转淘汰了多少条）
    // 存成一行保留记录。之前只认 items，dropped 写进去就读不回来，接口永远报 0。
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
                    // 顺序表坏了不该让整个面板起不来：下面会按「库里存在但没登记」
                    // 兜底把行补回来，只是顺序退化成 id 字典序。
                    ids = [];
                }
            }
            const list = [];
            const listed = new Set();
            for (const id of ids) {
                const data = byId.get(id);
                if (data === undefined) continue; // 顺序表里的悬空 id，跳过
                list.push(JSON.parse(data));
                listed.add(id);
            }
            // 兜底：库里有、顺序表里没有的行也要读出来，否则数据会「凭空消失」
            for (const [id, data] of byId) {
                if (listed.has(id)) continue;
                list.push(JSON.parse(data));
            }

            orderCache[key] = list.map((row) => String(row[idField] ?? ''));
            snapshotCache[key] = list;
            // rowCache 必须保留**完整行集**，且值用库里的原始 JSON 串 ——
            // 之前写成 `rowCache[key] = byId` 之后又在上面用 `byId.delete(id)`
            // 逐条掏空，重启后首次 writeSnapshot 里 planTable 对每一行都判定
            // `prevRows.get(id) !== json` → 整表重写一次，行级增量的意义全失
            // （审计 M6）。用原始串而非 JSON.stringify(JSON.parse(...))，保证与
            // planTable 生成的 nextRows 逐字符可比，不会误判为「全变了」。
            rowCache[key] = byId;
        }

        const meta = stmt('SELECT app, version, rev, updated_at, settings FROM meta WHERE id = 1').get();
        if (meta) {
            snapshotCache.app = meta.app;
            snapshotCache.version = meta.version;
            // rev 必须从库里读回来（不能默认 0）：它是写冲突检测的基线，
            // 重启后归零会让「重启后的第一次写」永远认为自己在旧基线上
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
                    /* 这一行坏了不该让统计整体不可用，当没有 */
                }
                continue;
            }
            statsRowCache.set(r.id, r.data);
            items[r.id] = JSON.parse(r.data);
        }
        statsExtraJson = JSON.stringify(extra);
        statsCache = { ...extra, items };
    }

    /**
     * 算出一张表要写什么。分三类，因为代价差好几个数量级：
     *   · upsert —— data 变了或新增，要写整行（含正文，可能很大）
     *   · delete
     *   · 顺序变化 —— 只更新 order_index 那一行（几 KB）
     * 正文没变、只是位置变的行**不会**被写，这正是把顺序拆出去的意义。
     */
    function planTable(idField, list, prevRows, prevIds) {
        const nextRows = new Map();
        const nextIds = [];
        for (const row of list) {
            const id = String(row?.[idField] ?? '');
            if (!id) continue; // 没有主键的行不该存在，跳过而不是写坏库
            nextRows.set(id, JSON.stringify(row));
            nextIds.push(id);
        }

        const upserts = [];
        for (const [id, json] of nextRows) {
            if (prevRows.get(id) !== json) upserts.push([id, json]);
        }
        const deletes = [];
        for (const id of prevRows.keys()) if (!nextRows.has(id)) deletes.push(id);

        // 数组顺序变了才算（用 \u0000 拼接避免 id 里含分隔符时误判）
        const orderChanged = prevIds.join('\u0000') !== nextIds.join('\u0000');

        return { nextRows, nextIds, upserts, deletes, orderChanged };
    }

    /** 事务包装：一次业务操作里的所有表改动要么全成，要么全不成。 */
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
                /* 已经回滚 */
            }
            throw e;
        }
    }

    return {
        async readSnapshot() {
            hydrate();
            return structuredClone(snapshotCache);
        },

        /**
         * @param {{ expectedRev?: number }} [opts]
         *   expectedRev 存在时做一次**乐观锁**校验（审计 L6）：调用方读到快照时
         *   的 rev 必须与库里当前 rev 一致，否则说明期间有别的写入落库了 ——
         *   本次这份快照是基于旧基线算的，写下去会把那次修改整个盖掉，直接抛
         *   ConflictError 让 mutate 重读重放。
         *   不传则跳过校验（备份脚本、测试里的直接写入用得上）。
         */
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
                    // 在 BEGIN IMMEDIATE 事务内比对：拿到写锁之后读到的 rev 才是
                    // 权威值，事务外的先读后比会有同样长度的竞态窗口。
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
            // 存一份拷贝而不是直接引用调用方那个对象：调用方拿到返回值后仍可能
            // 继续改它（虽然目前没有），一旦改了缓存就和库对不上了。
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

            // items 之外的顶层字段一起落库（dropped 这类累计量）
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

        /** 让 WAL 落回主库文件。备份前调用，避免只拷到主库而丢掉最近的写入。 */
        checkpoint() {
            try {
                db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            } catch {
                /* 有别的连接在读时可能失败，不影响主流程 */
            }
        },

        close() {
            try {
                db.close();
            } catch {
                /* 已关闭 */
            }
        },
    };
}
