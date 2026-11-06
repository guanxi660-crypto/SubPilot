// 功能：分享範圍、下載範圍、混合 feed、讀取失敗資料保護的隔離回歸證據。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleShare, handleDownload, handleFeed } from '../apps/server/src/convert.js';
import { defaultSnapshot, mutate } from '../apps/server/src/storage.js';
import { parseNodes } from '../apps/server/src/nodes.js';

function fixture() {
  const snap = defaultSnapshot();
  snap.subs = [
    { name: 'public', source: 'local', content: 'trojan://public-pass@example.com:443#public' },
    { name: 'private', source: 'local', content: 'trojan://private-pass@example.com:443#private' },
    { name: 'yaml', source: 'local', content: 'proxies:\n  - {name: yaml, type: mieru, server: example.com, port: 1234, username: alice, password: secret, transport: TCP}' },
  ];
  snap.collections = [{ name: 'public-col', subscriptions: ['public', 'yaml'], process: [] }];
  snap.shares = [{ type: 'col', name: 'public-col', code: 'public-code' }];
  return { STORE: { readSnapshot: async () => structuredClone(snap) }, SUBPILOT_TOKEN: 'admin' };
}

for (const [handler, path] of [[handleShare, '/share/col/public-col'], [handleDownload, '/download/collection/public-col']]) {
  test(`${path} cannot read an unrelated private subscription`, async () => {
    const query = new URLSearchParams({ code: 'public-code', sub: 'private' });
    const response = await handler(new Request(`https://audit.invalid${path}?${query}`), fixture(), null,
      { path, query, method: 'GET', tokenFromAuth: '' });
    const body = await response.text();
    assert.ok(!Buffer.from(body, 'base64').toString().includes('private-pass'), 'private credentials escaped the authorized collection');
  });
}

test('mixed collection feed retains both URI and YAML nodes', async () => {
  const path = '/feed/col/public-col';
  const response = await handleFeed(new Request(`https://audit.invalid${path}`), fixture(), null,
    { path, query: new URLSearchParams({ code: 'public-code' }), tokenFromAuth: '' });
  assert.equal(response.status, 200);
  assert.equal(parseNodes(await response.text()).nodes.length, 2);
});

test('failed storage read must not overwrite existing data with defaults', async () => {
  const writes = [];
  const env = { STORE: { readSnapshot: async () => { throw new Error('temporary outage'); },
    writeSnapshot: async snap => writes.push(snap) } };
  await mutate(env, snap => snap.subs.push({ name: 'new' })).catch(() => {});
  assert.equal(writes.length, 0, 'read outage caused a replacement snapshot write');
});
