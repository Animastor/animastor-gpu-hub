#!/usr/bin/env node
'use strict';

/**
 * v0.3.3 access log (reports/2026-11-07/orch-v2-image-scene-run.md О3):
 *  - one line per request: method, path WITHOUT query, status, token-derived
 *    worker_id, ms — never headers, bodies, tokens or the query string;
 *  - 401 / 409 / relay 503 are logged one by one;
 *  - idle traffic (empty /task/next and /v3/task/next, 2xx beacons, /health)
 *    is folded into one summary line per interval.
 * Exit 0 = all passed.
 */

const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const { buildHubApp, WORKER_AUTH_MIRROR_KEY, PROTOCOL_VERSION } = require(path.join(__dirname, '..', 'gpu-hub.js'));

const WORKER_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = Buffer.from('test-secret-not-real');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = `wrk.${b64url(WORKER_ID)}.${b64url(SECRET)}`;
const HUB_KEY = 'hub-key-test-only';

const WRITE_OPS = new Set(['set', 'setex', 'setnx', 'del', 'unlink', 'hset', 'hsetnx', 'hdel', 'hincrby', 'lpush', 'rpush', 'lrem', 'ltrim',
  'rpoplpush', 'lmove', 'expire', 'pexpire', 'incr', 'incrby', 'sadd', 'srem', 'zadd', 'zrem', 'eval', 'multi']);

function recordingRedis() {
  const kv = new Map();
  const hashes = new Map();
  const calls = [];
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  const impl = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, String(v)); return 'OK'; },
    async del(...ks) { let n = 0; for (const k of ks) { if (kv.delete(k)) n++; } return n; },
    async hget(k, f) { const m = hashes.get(k); return m && m.has(f) ? m.get(f) : null; },
    async hset(k, f, v) { h(k).set(f, v); return 1; },
    async hdel(k, f) { const m = hashes.get(k); return m && m.delete(f) ? 1 : 0; },
    async scan() { return ['0', []]; },
    async hscan() { return ['0', []]; },
    async lrange() { return []; },
    async llen() { return 0; },
    async hlen() { return 0; },
    async rpush() { return 0; },
    async lrem() { return 0; },
    async expire() { return 1; },
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
  return { redis: proxy, calls, kv, writes: () => calls.filter((c) => WRITE_OPS.has(c.op.toLowerCase())) };
}

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

function setup({ config = {}, fetchImpl } = {}) {
  const r = recordingRedis();
  const lines = [];
  config = { ACCESS_LOG: (l) => lines.push(l), ...config };
  const app = buildHubApp({
    redis: r.redis,
    config: { BACKEND_URL: 'http://backend.invalid', GPU_HUB_API_KEY: HUB_KEY, BACKEND_INTERNAL_URL: 'http://backend-internal.test:3000/', ...config },
    fetchImpl,
    intervals: false,
  });
  const secretHash = crypto.createHash('sha256').update(SECRET).digest('hex');
  r.redis.hset(WORKER_AUTH_MIRROR_KEY, secretHash, JSON.stringify({ worker_id: WORKER_ID, workspace_id: 'ws-1', worker_type: 'audio', mode: 'private' }));
  r.calls.length = 0;   // the mirror seeding above is test setup, not hub behaviour
  return { app, lines, ...r };
}

async function call(app, method, p, { body, auth = true, apiKey } = {}) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${TOKEN}`;
    if (apiKey) headers['x-api-key'] = apiKey;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}


const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const JOB = { job_id: '7c0d9a3e-1111-4222-8333-444455556666', attempt: 1, kind: 'iu_image', upload_token: 'v1.SECRET-UPLOAD.sig' };

test('a relayed task: one line with method, path (no query), status, worker_id, ms; no token anywhere', async () => {
  const raw = JSON.stringify({ task: JOB });
  const b = backendStub(async () => ({ ok: true, status: 200, text: async () => raw, headers: { get: () => 'application/json' } }));
  const s = setup({ fetchImpl: b.fetchImpl });
  await call(s.app, 'GET', '/v3/task/next?type=audio&secret=q');
  assert.strictEqual(s.lines.length, 1, JSON.stringify(s.lines));
  assert.match(s.lines[0], new RegExp(`^\\[HTTP\\] GET /v3/task/next → 200 worker=${WORKER_ID} \\d+ms$`));
  for (const l of s.lines) {
    assert.ok(!l.includes('SECRET-UPLOAD') && !l.includes(TOKEN) && !l.includes('secret=q') && !l.includes(HUB_KEY), l);
  }
});

test('401 (no / bad credential) and 409 worker_type_mismatch are logged one by one', async () => {
  const b = backendStub(async () => jsonResponse(200, { task: null }));
  const s = setup({ fetchImpl: b.fetchImpl });
  await call(s.app, 'GET', '/v3/task/next', { auth: false });
  await call(s.app, 'GET', '/v3/task/next?type=video');
  assert.match(s.lines[0], /^\[HTTP\] GET \/v3\/task\/next → 401 worker=- \d+ms$/);
  assert.match(s.lines[1], new RegExp(`^\\[HTTP\\] GET /v3/task/next → 409 worker=${WORKER_ID} `));
});

test('relay failure (503) is logged as a request line', async () => {
  const s = setup({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await call(s.app, 'GET', '/v3/task/next');
  assert.ok(s.lines.some((l) => /^\[HTTP\] GET \/v3\/task\/next → 503 /.test(l)), JSON.stringify(s.lines));
});

test('idle traffic: empty polls + beacons are NOT logged one by one; one summary per flush', async () => {
  const b = backendStub(async (url) => (url.endsWith('/claim') ? jsonResponse(200, { task: null }) : jsonResponse(200, { cancel: [] })));
  const s = setup({ fetchImpl: b.fetchImpl });
  for (let i = 0; i < 5; i++) await call(s.app, 'GET', '/v3/task/next?type=audio');
  for (let i = 0; i < 3; i++) await call(s.app, 'POST', '/v3/beacon', { body: { current_job_id: null } });
  assert.deepStrictEqual(s.lines, [], `idle requests logged individually: ${JSON.stringify(s.lines)}`);
  s.app.locals.flushAccessLog();
  assert.strictEqual(s.lines.length, 1);
  assert.match(s.lines[0], /^\[HTTP\] idle \d+s: /);
  assert.ok(s.lines[0].includes('GET /v3/task/next empty ×5'), s.lines[0]);
  assert.ok(s.lines[0].includes('POST /v3/beacon 200 ×3'), s.lines[0]);
  assert.ok(s.lines[0].endsWith('(workers 1)'), s.lines[0]);
  s.app.locals.flushAccessLog();
  assert.strictEqual(s.lines.length, 1, 'an empty interval prints nothing');
});

test('legacy /task/next {task:null} and /health are idle too (middleware unit)', async () => {
  const express = require(require.resolve('express', { paths: [path.join(__dirname, '..')] }));
  const { createAccessLog } = require(path.join(__dirname, '..', 'gpu-hub.js'));
  const lines = [];
  const al = createAccessLog({ log: (l) => lines.push(l) });
  const app = express();
  app.use(al.middleware);
  app.get('/task/next', (req, res) => { res.locals.hubWorkerId = WORKER_ID; res.json({ task: null }); });
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/task/next-busy', (req, res) => res.json({ task: { job_id: 'j' } }));
  for (const p of ['/task/next?type=audio', '/task/next', '/health', '/task/next-busy']) await call(app, 'GET', p, { auth: false });
  assert.deepStrictEqual(lines.map((l) => l.replace(/\d+ms$/, 'Nms')), ['[HTTP] GET /task/next-busy → 200 worker=- Nms']);
  al.flush();
  assert.match(lines[1], /GET \/health 200 ×1, GET \/task\/next empty ×2 \(workers 1\)$/);
});

test('createAccessLog is exported and the summary interval is 60 s', async () => {
  const hub = require(path.join(__dirname, '..', 'gpu-hub.js'));
  assert.strictEqual(typeof hub.createAccessLog, 'function');
  assert.strictEqual(hub.ACCESS_SUMMARY_MS, 60000);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log(`  ok  - ${c.name}`); }
    catch (err) { failed++; console.log(`  FAIL - ${c.name}\n         ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n         ') : err}`); }
  }
  console.log(`${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
