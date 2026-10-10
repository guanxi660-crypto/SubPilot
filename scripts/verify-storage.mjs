// SQLite 存储层专项回归。
//
// 与其它 verify-*.mjs 不同，这个脚本不经过 HTTP，直接驱动存储层 —— 因为它要
// 验证的是「行级写入」这类**实现性质**：从接口行为上看不出来（数据看起来一样，
// 差别在到底写了多少字节）。做法是把 WAL 日志文件的大小当作写入量的代理指标。
//
// ⚠️ 测量前必须先 checkpoint(TRUNCATE)，否则 WAL 里还留着上一次写入的内容，
// 量出来的是累计值。这个坑第一次写的时候踩过。
//
// 用法：node --disable-warning=ExperimentalWarning scripts/verify-storage.mjs
// 只依赖 node:sqlite（Node 22.5+ 内置）。跑完自动清理临时目录。

import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSqliteStore } from '../apps/server/node/sqlite-store.mjs';

// ── 计数钩子：包装原生 prepare，统计各表**实际执行的 upsert 语句数** ──────
//
// 为什么不用 WAL 体积量「写了几行」：实测（见 .tmp-formats 的对照实验）发现
// SQLite 会跳过「内容与磁盘完全相同」的页写入 —— 把同一行原样写回，WAL 帧数
// 是 0。于是「缺陷版多写的那些行」在 WAL 上一帧都不体现，用 WAL 做断言会恒真。
// 这里改成直接数 INSERT ... ON CONFLICT 的执行次数，才是缺陷真正改变的量：
// 缺陷版重启后改 1 条会 upsert 5 次，修复版只 upsert 1 次。
const upsertCount = new Map();
{
    const origPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
        const st = origPrepare.call(this, sql);
        const m = /INSERT INTO (\w+)\b/.exec(sql);
        if (m) {
            const table = m[1];
            const origRun = st.run;
            st.run = function (...args) {
                upsertCount.set(table, (upsertCount.get(table) || 0) + 1);
                return origRun.apply(this, args);
            };
        }
        return st;
    };
}
const resetCounts = () => upsertCount.clear();
const countOf = (table) => upsertCount.get(table) || 0;

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
    cond ? pass++ : fail++;
};

const dir = mkdtempSync(join(tmpdir(), 'subpilot-storage-'));
const dbFile = join(dir, 'subpilot.db');

const sub = (name, content = '') => ({ name, url: 'https://example.com/s', content, createdAt: name });
const big = (n) => 'x'.repeat(n);
const kb = (n) => `${(n / 1024).toFixed(0)}KB`;

try {
    const store = createSqliteStore(dbFile);

    /** WAL 字节数；调用前先 checkpoint，量到的才是「上一笔写入量」。 */
    const measure = async (fn) => {
        store.checkpoint();
        await fn();
        return existsSync(`${dbFile}-wal`) ? statSync(`${dbFile}-wal`).size : 0;
    };

    console.log('\n[1] 基本读写与顺序');

    let cur = {
        app: 'SubPilot',
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        subs: [sub('A'), sub('B'), sub('C')],
        collections: [],
        files: [],
        converted: [],
        shares: [],
        templates: [],
        settings: { defaultTarget: 'clash', ai: { baseUrl: '', model: '', apiKey: '' } },
    };
    await store.writeSnapshot(cur);
    cur = await store.readSnapshot();

    ok('读回订阅', cur.subs.length === 3, `${cur.subs.length} 条`);
    ok('顺序保持', cur.subs.map((x) => x.name).join(',') === 'A,B,C', cur.subs.map((x) => x.name).join(','));
    ok('设置被保留', cur.settings.defaultTarget === 'clash');

    // 全新的库：应返回一个「空快照」，且不含 settings —— 让 storage.js 的
    // normalizeSnapshot 去补默认值，而不是在这里塞一份可能过期的默认设置。
    const empty = createSqliteStore(join(dir, 'empty.db'));
    const e = await empty.readSnapshot();
    ok('空库返回空快照而非抛错', !!e && Array.isArray(e.subs) && e.subs.length === 0);
    ok('空快照不带 settings（交给上层补默认值）', e.settings === undefined, JSON.stringify(e.settings));
    empty.close();

    console.log('\n[2] 顺序语义（新增/删除/重排）');

    cur = { ...cur, subs: [sub('D'), ...cur.subs] }; // 模拟 API 的 unshift
    await store.writeSnapshot(cur);
    cur = await store.readSnapshot();
    ok('unshift 后顺序正确', cur.subs.map((x) => x.name).join(',') === 'D,A,B,C', cur.subs.map((x) => x.name).join(','));

    cur.subs.splice(2, 1); // 模拟删中间项
    await store.writeSnapshot(cur);
    cur = await store.readSnapshot();
    ok('删除中间项后顺序正确', cur.subs.map((x) => x.name).join(',') === 'D,A,C', cur.subs.map((x) => x.name).join(','));

    cur = { ...cur, subs: [...cur.subs].reverse() };
    await store.writeSnapshot(cur);
    cur = await store.readSnapshot();
    ok('倒序后顺序正确', cur.subs.map((x) => x.name).join(',') === 'C,A,D', cur.subs.map((x) => x.name).join(','));

    console.log('\n[3] shares 以 code 为主键（允许同名多条）');

    cur = {
        ...cur,
        shares: [
            { code: 'c1', type: 'sub', name: '同名' },
            { code: 'c2', type: 'sub', name: '同名' },
            { code: 'c3', type: 'file', name: '别的' },
        ],
    };
    await store.writeSnapshot(cur);
    cur = await store.readSnapshot();
    ok('三条同名分享码都在', cur.shares.length === 3, `${cur.shares.length} 条`);
    ok('分享码顺序保持', cur.shares.map((x) => x.code).join(',') === 'c1,c2,c3');

    cur = { ...cur, shares: cur.shares.filter((x) => x.code !== 'c2') };
    await store.writeSnapshot(cur);
    cur = await store.readSnapshot();
    ok('删除单条分享码', cur.shares.map((x) => x.code).join(',') === 'c1,c3', cur.shares.map((x) => x.code).join(','));

    console.log('\n[4] 行级写入（核心性能性质）');

    const BODY = 200 * 1024; // 单条正文 200KB
    const NAMES = ['S1', 'S2', 'S3', 'S4', 'S5'];
    cur = { ...cur, subs: NAMES.map((n) => sub(n, big(BODY))) };
    await store.writeSnapshot(cur);

    // 只改第 3 条的正文
    cur = await store.readSnapshot();
    cur.subs[2] = { ...cur.subs[2], content: big(BODY) + 'PATCHED' };
    const oneRow = await measure(() => store.writeSnapshot(cur));

    // 五条全改
    cur = await store.readSnapshot();
    cur.subs = cur.subs.map((x, i) => ({ ...x, content: big(BODY) + `ALL${i}` }));
    const allRows = await measure(() => store.writeSnapshot(cur));

    const total = BODY * NAMES.length;
    ok(
        '改一条的写入量远小于改五条',
        oneRow * 2 < allRows,
        `1 行=${kb(oneRow)} · 5 行=${kb(allRows)}`,
    );
    ok(
        '改一条不会把整个数据集重写一遍',
        oneRow < BODY * 2,
        `写入 ${kb(oneRow)}，单条正文 ${kb(BODY)}，全量约 ${kb(total)}`,
    );

    console.log('\n[5] 只挪位置用轻量 UPDATE');

    cur = await store.readSnapshot();
    const reversed = { ...cur, subs: [...cur.subs].reverse() };
    const reorderOnly = await measure(() => store.writeSnapshot(reversed));
    ok(
        '纯重排的写入量远小于正文总量',
        reorderOnly < BODY,
        `${kb(reorderOnly)}（正文合计 ${kb(total)}）`,
    );

    console.log('\n[6] 统计行级 UPSERT');

    const items = {};
    for (let i = 0; i < 200; i++) {
        items[`类型|项目${i}|1.2.3.${i % 250}`] = { type: '类型', item: `项目${i}`, ip: '1.1.1.1', count: 1, last: '2026-01-01' };
    }
    const statsAll = await measure(() => store.writeStats({ items }));

    const one = await store.readStats();
    one.items['类型|项目7|1.2.3.7'].count = 2;
    const statsOne = await measure(() => store.writeStats(one));

    const back = await store.readStats();
    ok('统计条目读回完整', Object.keys(back.items).length === 200, `${Object.keys(back.items).length} 条`);
    ok('改动的计数生效', back.items['类型|项目7|1.2.3.7'].count === 2);
    ok(
        '改一条统计的写入量远小于全量',
        statsOne * 3 < statsAll,
        `1 条=${statsOne}B · 200 条=${statsAll}B`,
    );

    console.log('\n[7] 重启后数据仍在');

    store.close();
    const reopened = createSqliteStore(dbFile);
    const after = await reopened.readSnapshot();
    ok('重开后订阅还在', after.subs.length === 5, `${after.subs.length} 条`);
    ok('重开后顺序还在', after.subs.map((x) => x.name).join(',') === 'S5,S4,S3,S2,S1', after.subs.map((x) => x.name).join(','));
    ok('重开后分享码还在', after.shares.map((x) => x.code).join(',') === 'c1,c3', after.shares.map((x) => x.code).join(','));
    ok('重开后设置还在', after.settings.defaultTarget === 'clash');
    ok('重开后统计还在', Object.keys((await reopened.readStats()).items).length === 200);

    // [8] 审计 M6 回归：**重启后的第一次写入**必须是行级增量。
    // 曾经的实现是 hydrate 里 `rowCache[key] = byId` 之后又用 `byId.delete(id)`
    // 逐条掏空同一个 Map 引用，于是重开后 prevRows 是空的 —— planTable 判定
    // 每一行都「变了」，首写把整表（含 5×200KB 正文）全量重写一遍。
    // reopened 是 [7] 重启出来的 store，这里量「只改 1 条」实际 upsert 了几行。
    console.log('\n[8] 重启后首写仍是行级增量（审计 M6 回归）');

    let after8 = await reopened.readSnapshot();
    after8.subs[1] = { ...after8.subs[1], note: '只改这一条' };
    resetCounts();
    await reopened.writeSnapshot(after8);
    const upsertOneRow = countOf('subs');

    after8 = await reopened.readSnapshot();
    after8.subs = after8.subs.map((x, i) => ({ ...x, note: `全改${i}` }));
    resetCounts();
    await reopened.writeSnapshot(after8);
    const upsertAllRows = countOf('subs');

    ok('重启后只改 1 条 → 只 upsert 1 行', upsertOneRow === 1, `实际 ${upsertOneRow} 行`);
    ok('改 5 条 → upsert 5 行（对照）', upsertAllRows === 5, `实际 ${upsertAllRows} 行`);
    ok(
        '重启后首写量级是「1 行」而非「5 行」',
        upsertOneRow * 2 < upsertAllRows,
        `1 条=${upsertOneRow} 行 · 5 条=${upsertAllRows} 行`,
    );

    reopened.close();
} finally {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* Windows 上文件偶尔还被占着，忽略 */
    }
}

console.log(`\n== 存储层回归：${pass} 通过 / ${fail} 失败 ==\n`);
process.exit(fail ? 1 : 0);
