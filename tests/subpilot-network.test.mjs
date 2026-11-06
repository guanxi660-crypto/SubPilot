// 功能：跨網域重新導向憑證保護、Telegram 頻道識別碼保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch } from '../apps/server/src/netguard.js';
import { parseChatIds } from '../apps/server/src/telegram.js';

test('cross-origin redirect strips Authorization', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }) : new Response('ok');
  };
  try {
    await safeFetch('https://dav.example/', { headers: { Authorization: 'Basic test-only' } });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].auth, null);
  } finally { globalThis.fetch = original; }
});

test('Telegram channel username keeps its required at-sign', () => {
  assert.deepEqual(parseChatIds('@audit_channel'), ['@audit_channel']);
});
