#!/usr/bin/env node
'use strict';

/**
 * Protocol 3 relay (ORCHESTRATION_V2 ADR §8, invariant I6) + scoped-only
 * DELETE /queue/clear (I7). Behavioural, in-process: real express app from
 * buildHubApp, recording in-memory Redis, mocked backend (stub fetch and one
 * real refused connection). Exit 0 = all passed.
 *
 *  - GET /v3/task/next → POST {BACKEND_INTERNAL_URL}/internal/gen/claim
 *    {worker_id, worker_type} with x-api-key; the backend answer goes back as is;
 *  - POST /v3/beacon → POST /internal/gen/beacon {worker_id, current_job_id};
 *    {cancel:[…]} back to the worker; the hub refreshes ONLY its own heartbeat key;
 *  - no BACKEND_INTERNAL_URL → 503 v3_not_configured; backend down / timeout → 503
 *    backend_unavailable, exactly one attempt (no retries of its own);
 *  - the v3 path writes NOTHING to Redis except that heartbeat key;
 *  - DELETE /queue/clear without parameters → 400 before touching Redis.
 */

const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const { buildHubApp, WORKER_AUTH_MIRROR_KEY } = require(path.join(__dirname, '..', 'gpu-hub.js'));

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
  const app = buildHubApp({
    redis: r.redis,
    config: { BACKEND_URL: 'http://backend.invalid', GPU_HUB_API_KEY: HUB_KEY, BACKEND_INTERNAL_URL: 'http://backend-internal.test:3000/', ...config },
    fetchImpl,
    intervals: false,
  });
  const secretHash = crypto.createHash('sha256').update(SECRET).digest('hex');
  r.redis.hset(WORKER_AUTH_MIRROR_KEY, secretHash, JSON.stringify({ worker_id: WORKER_ID, workspace_id: 'ws-1', worker_type: 'audio', mode: 'private' }));
  r.calls.length = 0;   // the mirror seeding above is test setup, not hub behaviour
  return { app, ...r };
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

const TASK = {
  job_id: '7c0d9a3e-1111-4222-8333-444455556666', attempt: 1, kind: 'audio_chunk', params: { '3': { class_type: 'SaveAudio', inputs: { b: 2, a: 1 } } },
  timeout_ms: 600000, upload_token: 'v1.1.sig', upload_url: 'https://animastor.org/internal/gen/jobs/x/result?attempt=1', protocol_version: 3,
};

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('/v3/task/next relays to /internal/gen/claim {worker_id, worker_type} with x-api-key; body back byte-for-byte', async () => {
  const raw = JSON.stringify({ task: TASK });
  const b = backendStub(async () => ({ ok: true, status: 200, text: async () => raw, headers: { get: () => 'application/json; charset=utf-8' } }));
  const s = setup({ fetchImpl: b.fetchImpl });
  const r = await call(s.app, 'GET', '/v3/task/next?type=audio');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, raw, 'relayed body must be the backend body as is');
  assert.strictEqual(b.posts.length, 1);
  assert.strictEqual(b.posts[0].url, 'http://backend-internal.test:3000/internal/gen/claim');
  assert.deepStrictEqual(b.posts[0].body, { worker_id: WORKER_ID, worker_type: 'audio' });
  assert.strictEqual(b.posts[0].headers['x-api-key'], HUB_KEY);
  assert.deepStrictEqual(s.writes(), [], `v3 next wrote to Redis: ${JSON.stringify(s.writes())}`);
  assert.deepStrictEqual([...new Set(s.calls.map((c) => c.op))], ['hget'], 'only the worker-auth mirror read');
});

test('/v3/task/next {task:null} passes through; no Redis write', async () => {
  const b = backendStub(async () => jsonResponse(200, { task: null }));
  const s = setup({ fetchImpl: b.fetchImpl });
  const r = await call(s.app, 'GET', '/v3/task/next?type=audio');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { task: null });
  assert.deepStrictEqual(s.writes(), []);
});

test('/v3/task/next type ≠ credential type → 409, backend not called', async () => {
  const b = backendStub(async () => jsonResponse(200, { task: null }));
  const s = setup({ fetchImpl: b.fetchImpl });
  const r = await call(s.app, 'GET', '/v3/task/next?type=image');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error, 'worker_type_mismatch');
  assert.strictEqual(b.posts.length, 0);
});

test('/v3/* without a worker credential → 401, backend not called', async () => {
  const b = backendStub(async () => jsonResponse(200, { task: null }));
  const s = setup({ fetchImpl: b.fetchImpl });
  assert.strictEqual((await call(s.app, 'GET', '/v3/task/next?type=audio', { auth: false })).status, 401);
  assert.strictEqual((await call(s.app, 'POST', '/v3/beacon', { auth: false, body: {} })).status, 401);
  assert.strictEqual(b.posts.length, 0);
  assert.deepStrictEqual(s.writes(), []);
});

test('BACKEND_INTERNAL_URL not set → 503 v3_not_configured on both endpoints, no Redis write', async () => {
  const b = backendStub(async () => jsonResponse(200, { task: null }));
  const s = setup({ config: { BACKEND_INTERNAL_URL: null }, fetchImpl: b.fetchImpl });
  const n = await call(s.app, 'GET', '/v3/task/next?type=audio');
  assert.strictEqual(n.status, 503);
  assert.strictEqual(n.json.error, 'v3_not_configured');
  assert.match(n.json.message, /BACKEND_INTERNAL_URL/);
  const bc = await call(s.app, 'POST', '/v3/beacon', { body: { current_job_id: null } });
  assert.strictEqual(bc.status, 503);
  assert.strictEqual(bc.json.error, 'v3_not_configured');
  assert.strictEqual(b.posts.length, 0);
  assert.deepStrictEqual(s.writes(), []);
});

test('backend refuses the connection (real socket) → 503 backend_unavailable, one attempt, no Redis write', async () => {
  const s = setup({ config: { BACKEND_INTERNAL_URL: 'http://127.0.0.1:1' } });   // real fetch, port 1 refuses
  const r = await call(s.app, 'GET', '/v3/task/next?type=audio');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error, 'backend_unavailable');
  assert.deepStrictEqual(s.writes(), []);
});

test('backend error → exactly one relay attempt (no hub retries)', async () => {
  const b = backendStub(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
  const s = setup({ fetchImpl: b.fetchImpl });
  const r = await call(s.app, 'GET', '/v3/task/next?type=audio');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(b.posts.length, 1);
});

test('backend hangs → relay aborts at the timeout → 503 (timeout in the message)', async () => {
  const b = backendStub((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const s = setup({ config: { V3_RELAY_TIMEOUT_MS: 150 }, fetchImpl: b.fetchImpl });
  const t0 = Date.now();
  const r = await call(s.app, 'GET', '/v3/task/next?type=audio');
  assert.strictEqual(r.status, 503);
  assert.match(r.json.message, /timeout 150ms/);
  assert.ok(Date.now() - t0 < 3000, 'aborted near the configured timeout');
});

test('default relay timeout is 10 s', async () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'gpu-hub.js'), 'utf8');
  assert.match(src, /V3_RELAY_TIMEOUT_MS\) : 10000;/);
});

test('backend 503 (orch v2 disabled) / 403 pass through as is; backend 401 (hub key) → 502', async () => {
  for (const [status, body, expect] of [[503, { code: 'orch_v2_disabled' }, 503], [403, { code: 'unknown_worker' }, 403], [401, { code: 'unauthorized' }, 502]]) {
    const b = backendStub(async () => jsonResponse(status, body));
    const s = setup({ fetchImpl: b.fetchImpl });
    const r = await call(s.app, 'GET', '/v3/task/next?type=audio');
    assert.strictEqual(r.status, expect, `backend ${status} → ${r.status}`);
    if (expect !== 502) assert.deepStrictEqual(r.json, body);
    else assert.strictEqual(r.json.error, 'backend_rejected_hub_key');
  }
});

test('/v3/beacon relays {worker_id, current_job_id} → {cancel} back; writes ONLY the hub heartbeat key (EX 30)', async () => {
  const b = backendStub(async () => jsonResponse(200, { cancel: ['job-x'] }));
  const s = setup({ fetchImpl: b.fetchImpl });
  const r = await call(s.app, 'POST', '/v3/beacon', { body: { gpu: 'RTX', vram: '24GB', version: '2.4.0', current_job_id: 'job-x', worker_id: 'spoofed' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { cancel: ['job-x'] });
  assert.strictEqual(b.posts.length, 1);
  assert.strictEqual(b.posts[0].url, 'http://backend-internal.test:3000/internal/gen/beacon');
  assert.deepStrictEqual(b.posts[0].body, { worker_id: WORKER_ID, current_job_id: 'job-x' }, 'identity from the token, never from the body');
  const w = s.writes();
  assert.strictEqual(w.length, 1, `exactly one Redis write, got ${JSON.stringify(w.map((c) => c.op + ' ' + c.args[0]))}`);
  assert.strictEqual(w[0].op, 'set');
  assert.strictEqual(w[0].args[0], `animastor:worker:heartbeat:audio:${WORKER_ID}`);
  assert.deepStrictEqual(w[0].args.slice(2), ['EX', 30]);
  const hb = JSON.parse(w[0].args[1]);
  assert.strictEqual(hb.current_job_id, 'job-x');
  assert.strictEqual(hb.version, '2.4.0');
  assert.strictEqual(hb.mode, 'private');
  // the v2 registry (gpu-hub:workers) is not touched — the v2 pop still sees the v2 beacon's protocol_version
  assert.ok(!s.calls.some((c) => String(c.args[0]).includes('gpu-hub:workers')), 'registry untouched');
});

test('/v3/beacon with backend down → 503, heartbeat still refreshed (hub-own liveness for the UI)', async () => {
  const b = backendStub(async () => { throw new Error('ECONNREFUSED'); });
  const s = setup({ fetchImpl: b.fetchImpl });
  const r = await call(s.app, 'POST', '/v3/beacon', { body: { version: '2.4.0' } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error, 'backend_unavailable');
  const w = s.writes();
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].args[0].startsWith('animastor:worker:heartbeat:audio:'));
  assert.strictEqual(JSON.parse(w[0].args[1]).current_job_id, null);
});

test('DELETE /queue/clear without parameters → 400 scope_required, zero Redis calls', async () => {
  const s = setup();
  for (const q of ['', '?book_id=', '?book_id=&dispatch_id=&workspace_id=']) {
    const r = await call(s.app, 'DELETE', `/queue/clear${q}`, { auth: false, apiKey: HUB_KEY });
    assert.strictEqual(r.status, 400, `"${q}" → ${r.status}`);
    assert.strictEqual(r.json.error, 'scope_required');
  }
  assert.deepStrictEqual(s.calls, [], 'no Redis access at all for a parameterless clear');
});

test('DELETE /queue/clear?book_id=… still works (scoped)', async () => {
  const s = setup();
  const r = await call(s.app, 'DELETE', '/queue/clear?book_id=book-1', { auth: false, apiKey: HUB_KEY });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.scope.book_id, 'book-1');
});

test('the full-clear code path is gone from the source', async () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'gpu-hub.js'), 'utf8');
  assert.ok(!src.includes('All gpu-hub queues cleared'), 'full-clear answer still present');
  assert.ok(!src.includes("redis.del('animastor:running')"), 'running wipe still present');
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
