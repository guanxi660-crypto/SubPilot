// 功能：去重、Reality、百分號解碼、HTTP 標準埠的回歸證據。
import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeClashResult } from '../apps/server/src/nodes.js';
import { uriToClashObj } from '../apps/server/src/uri2clash.js';

test('generated duplicate suffix does not collide with an existing name', () => {
  const nodes = ['A', 'A', 'A-2'].map(name => ({ obj: { name, type: 'direct' } }));
  const names = serializeClashResult(nodes).proxies.map(p => p.name);
  assert.equal(new Set(names).size, 3);
});
test('Trojan Reality retains its public key', () => {
  const proxy = uriToClashObj('trojan://pass@example.com:443?security=reality&pbk=public-key&sid=abcd', 'test');
  assert.equal(proxy['reality-opts']?.['public-key'], 'public-key');
});
test('percent-encoded password is decoded exactly once', () => {
  assert.equal(uriToClashObj('trojan://p%252F@example.com:443', 'test').password, 'p%2F');
});
test('explicit standard HTTPS proxy port is preserved', () => {
  const proxy = uriToClashObj('https://user:pass@example.com:443', 'test');
  assert.ok(proxy);
  assert.equal(proxy.port, 443);
  assert.equal(proxy.tls, true);
});
