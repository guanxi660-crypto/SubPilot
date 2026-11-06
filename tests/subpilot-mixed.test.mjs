// 功能：混貼解析分段錯誤的 RED 證據（編輯窗口混編條目錯誤回報）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNodes } from '../apps/server/src/nodes.js';

const URI = 'vless://8f1c@2.2.2.2:443?security=tls#mid';
const A = 'proxies:\n  - {name: a, type: ss, server: 1.1.1.1, port: 1}';
const B = '  - {name: b, type: ss, server: 3.3.3.3, port: 3}';

test('URI pasted inside a YAML list keeps the following entries', () => {
  const r = parseNodes(`${A}\n${URI}\n${B}`);
  assert.deepEqual(r.nodes.map((n) => n.name), ['a', 'mid', 'b']);
  assert.ok(!r.error, 'silent partial loss must surface an error');
});

test('mixed content with --- separator keeps both YAML documents', () => {
  const r = parseNodes(`${A}\n---\nproxies:\n  - {name: b, type: ss, server: 3.3.3.3, port: 3}\n${URI}`);
  assert.deepEqual(r.nodes.map((n) => n.name).sort(), ['a', 'b', 'mid']);
  assert.ok(!r.error, 'silent partial loss must surface an error');
});

test('mierus scheme emitted by mieru-lite is recognized as a URI node', () => {
  // mieru-lite.sh 實際輸出：埠與協議在 query（port=...&protocol=...）
  const r = parseNodes('mierus://alice:secret@192.0.2.1?port=2222&protocol=TCP#m1');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].port, 2222);
});
