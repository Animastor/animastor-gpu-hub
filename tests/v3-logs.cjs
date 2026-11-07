#!/usr/bin/env node
'use strict';

/**
 * Fresh worker logs — hub side (ORCHESTRATION_V2 §8.5).
 *
 * Behavioural, in-process: the real express app from buildHubApp, a recording
 * in-memory Redis and a mocked backend. Covered:
 *   - POST /v3/logs authenticates with the SAME worker Bearer gate (no
 *     credential → 401, backend not called);
 *   - the gzip JSON body is forwarded to
 *     {BACKEND_INTERNAL_URL}/internal/workers/<token worker_id>/logs with
 *     x-api-key; the body's worker_id is a label and never the URL identity;
 *   - the v3/logs path writes NOTHING to Redis;
 *   - a wire body > 128 KiB → 413 before any relay;
 *   - invalid JSON / no lines[] → 400;
 *   - BACKEND_INTERNAL_URL unset → 503 v3_not_configured; backend down → 503.
 * Exit 0 = all passed.
 */

const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const assert = require('assert');

const { buildHubApp, WORKER_AUTH_MIRROR_KEY } = require(path.join(__dirname, '..', 'gpu-hub.js'));

const WORKER_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = Buffer.from('logs-test-secret-not-real');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = `wrk.${b64url(WORKER_ID)}.${b64url(SECRET)}`;
const HUB_KEY = 'hub-key-test-only';
const LOG_LIMIT = 128 * 1024;

const WRITE_OPS = new Set(['set', 'setex', 'hset', 'hdel', 'del', 'unlink', 'lpush', 'rpush', 'lrem', 'expire', 'incr', 'sadd', 'zadd', 'eval', 'multi']);

function backendStub(handler) {
  const posts = [];
  const fetchImpl = async (url, opts) => {
    posts.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return handler(url, opts, posts.length);
  };
  return { posts, fetchImpl };
}

function jsonResponse(status, obj) {
  const text = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: () => 'application/json; charset=utf-8' } };
}

// A simpler, faithful setup: a Map-backed mirror with real hget/hset.
function setupReal({ config = {}, fetchImpl } = {}) {
  const calls = [];
  const hashes = new Map();
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  const impl = {
    async get() { return null; },
    async set() { return 'OK'; },
    async del() { return 0; },
    async hget(k, f) { const m = hashes.get(k); return m && m.has(f) ? m.get(f) : null; },
    async hset(k, f, v) { h(k).set(f, v); return 1; },
    async hdel() { return 0; },
  };
  const proxy = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string' || !(prop in target)) {
        if (typeof prop === 'string' && prop !== 'then') {
          return async (...args) => { calls.push({ op: prop, args }); return null; };
        }
        return undefined;
      }
      return async (...args) => { calls.push({ op: prop, args }); return target[prop](...args); };
    },
  });
  const app = buildHubApp({
    redis: proxy,
    config: { BACKEND_URL: 'http://backend.invalid', GPU_HUB_API_KEY: HUB_KEY, BACKEND_INTERNAL_URL: 'http://backend-internal.test:3000/', ...config },
    fetchImpl,
    intervals: false,
  });
  proxy.hset(WORKER_AUTH_MIRROR_KEY, crypto.createHash('sha256').update(SECRET).digest('hex'),
    JSON.stringify({ worker_id: WORKER_ID, workspace_id: 'ws-1', worker_type: 'audio', mode: 'private' }));
  calls.length = 0;
  return { app, calls, writes: () => calls.filter((c) => WRITE_OPS.has(c.op.toLowerCase())) };
}

async function postLogs(app, { body, gzip = true, auth = true, headers = {}, method = 'POST', p = '/v3/logs' } = {}) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (auth) h.Authorization = `Bearer ${TOKEN}`;
    let payload = body;
    if (body != null && !Buffer.isBuffer(body)) payload = Buffer.from(JSON.stringify(body), 'utf8');
    if (gzip && payload != null) { payload = zlib.gzipSync(payload); h['Content-Encoding'] = 'gzip'; }
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const VALID = {
  worker_id: 'spoofed-not-the-token-id',
  seq_from: 10,
  seq_to: 12,
  lines: [
    { ts: '2026-11-06T10:00:00.000Z', level: 'info', msg: 'line one' },
    { ts: '2026-11-06T10:00:01.000Z', level: 'warn', msg: 'line two' },
    { ts: '2026-11-06T10:00:02.000Z', level: 'error', msg: 'line three' },
  ],
};

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('/v3/logs forwards the parsed body to /internal/workers/<token id>/logs with x-api-key; zero Redis writes', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ fetchImpl: b.fetchImpl });
  const r = await postLogs(s.app, { body: VALID });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(b.posts.length, 1);
  assert.strictEqual(b.posts[0].url, `http://backend-internal.test:3000/internal/workers/${WORKER_ID}/logs`);
  assert.strictEqual(b.posts[0].headers['x-api-key'], HUB_KEY);
  assert.deepStrictEqual(b.posts[0].body, VALID, 'body forwarded as parsed JSON');
  assert.strictEqual(b.posts[0].body.worker_id, 'spoofed-not-the-token-id', 'the body label is part of the payload');
  assert.deepStrictEqual(s.writes(), [], `v3/logs wrote to Redis: ${JSON.stringify(s.writes())}`);
});

test('/v3/logs accepts a plain JSON body too', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ fetchImpl: b.fetchImpl });
  const r = await postLogs(s.app, { body: VALID, gzip: false });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(b.posts.length, 1);
});

test('/v3/logs without a worker credential → 401, backend not called', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ fetchImpl: b.fetchImpl });
  const r = await postLogs(s.app, { body: VALID, auth: false });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(b.posts.length, 0);
});

test('a wire body > 128 KiB → 413 before any relay (zero Redis writes)', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ fetchImpl: b.fetchImpl });
  const big = { ...VALID, lines: [{ ts: 'x', level: 'info', msg: 'x'.repeat(LOG_LIMIT + 1024) }] };
  const r = await postLogs(s.app, { body: big, gzip: false });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.json.error, 'payload_too_large');
  assert.strictEqual(b.posts.length, 0);
  assert.deepStrictEqual(s.writes(), []);
});

test('gzip that inflates past the sanity cap → 413', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ fetchImpl: b.fetchImpl, config: { V3_LOG_INFLATED_LIMIT: 4096 } });
  const big = { ...VALID, lines: [{ ts: 'x', level: 'info', msg: 'a'.repeat(20000) }] };
  const r = await postLogs(s.app, { body: big });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(b.posts.length, 0);
});

test('invalid JSON → 400; missing lines[] → 400', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ fetchImpl: b.fetchImpl });
  const invalid = await postLogs(s.app, { body: Buffer.from('{not json', 'utf8'), gzip: true });
  assert.strictEqual(invalid.status, 400);
  const noLines = await postLogs(s.app, { body: { worker_id: 'x' } });
  assert.strictEqual(noLines.status, 400);
  assert.strictEqual(b.posts.length, 0);
});

test('BACKEND_INTERNAL_URL unset → 503 v3_not_configured', async () => {
  const b = backendStub(async () => jsonResponse(204, {}));
  const s = setupReal({ config: { BACKEND_INTERNAL_URL: null }, fetchImpl: b.fetchImpl });
  const r = await postLogs(s.app, { body: VALID });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error, 'v3_not_configured');
  assert.strictEqual(b.posts.length, 0);
});

test('backend down → 503 backend_unavailable, one attempt', async () => {
  const b = backendStub(async () => { throw new Error('ECONNREFUSED'); });
  const s = setupReal({ fetchImpl: b.fetchImpl });
  const r = await postLogs(s.app, { body: VALID });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error, 'backend_unavailable');
  assert.strictEqual(b.posts.length, 1);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log(`  ok  - ${c.name}`); }
    catch (err) { failed++; console.log(`  FAIL - ${c.name}\n         ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n         ') : err}`); }
  }
  console.log(`${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();