#!/usr/bin/env node
'use strict';

/**
 * /task/result ACK — the fallback key animastor:result:* is removed by the hub
 * once the backend settled the delivery, and kept whenever the outcome is not
 * final (deduped / non-2xx / unreadable). Compare-and-delete: a newer result
 * of the same scene×type (next IU) that overwrote the key is never removed.
 *
 * Behavioural, in-process: real express app from buildHubApp, in-memory
 * Redis, stubbed backend fetch. Exit code 0 = all passed.
 */

const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const { buildHubApp, WORKER_AUTH_MIRROR_KEY, PROTOCOL_VERSION } = require(path.join(__dirname, '..', 'gpu-hub.js'));

const WORKER_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = Buffer.from('test-secret-not-real');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = `wrk.${b64url(WORKER_ID)}.${b64url(SECRET)}`;

function fakeRedis() {
  const kv = new Map();
  const hashes = new Map();
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  return {
    kv,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, String(v)); return 'OK'; },
    async del(...ks) { let n = 0; for (const k of ks) { if (kv.delete(k)) n++; } return n; },
    async hget(k, f) { const m = hashes.get(k); return m && m.has(f) ? m.get(f) : null; },
    async hset(k, f, v) { h(k).set(f, v); return 1; },
    async hdel(k, f) { const m = hashes.get(k); return m && m.delete(f) ? 1 : 0; },
    async lrem() { return 0; },
    async expire() { return 1; },
    // Only the ACK compare-and-delete script is used by /task/result.
    async eval(script, numKeys, key, expected) {
      assert.ok(/GET/.test(script) && /DEL/.test(script), 'unexpected script');
      if (kv.get(key) === expected) { kv.delete(key); return 1; }
      return 0;
    },
  };
}

function setup(backendAnswer) {
  const redis = fakeRedis();
  const posts = [];
  const fetchImpl = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    const a = typeof backendAnswer === 'function' ? backendAnswer(redis, posts.length) : backendAnswer;
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      json: async () => { if (a.body === undefined) throw new Error('no json'); return a.body; },
    };
  };
  const app = buildHubApp({ redis, config: { BACKEND_URL: 'http://backend.invalid', GPU_HUB_API_KEY: 'k' }, fetchImpl, intervals: false });
  const secretHash = crypto.createHash('sha256').update(SECRET).digest('hex');
  redis.hset(WORKER_AUTH_MIRROR_KEY, secretHash, JSON.stringify({ worker_id: WORKER_ID, workspace_id: 'ws-1', worker_type: 'image', mode: 'private' }));
  return { app, redis, posts };
}

const JOB = 'book1_ch-1_sc-1_iu-aaaa:iu_image';
const KEY = 'animastor:result:build1:book1:ch-1:sc-1:image';

async function seedRunning(redis, jobId = JOB, dispatchId = 'disp-1') {
  await redis.hset('animastor:running', jobId, JSON.stringify({
    dispatch_id: dispatchId, worker: WORKER_ID, workspace_id: 'ws-1', stage: 'image',
    book_id: 'book1', chapter_id: 'ch-1', scene_id: 'sc-1', job_type: 'image', worker_mode: 'private',
  }));
}

async function postResult(app, jobId = JOB, dispatchId = 'disp-1', bytes = 'AAAA') {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/task/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ job_id: jobId, build_id: 'build1', dispatch_id: dispatchId, protocol_version: PROTOCOL_VERSION, result_base64: bytes }),
    });
    return res.status;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('processed ({ok:true}) → result key deleted', async () => {
  const { app, redis, posts } = setup({ status: 200, body: { ok: true } });
  await seedRunning(redis);
  assert.strictEqual(await postResult(app), 200);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(await redis.get(KEY), null);
});

test('terminal reject ({ok:true, rejected:true}) → result key deleted', async () => {
  const { app, redis } = setup({ status: 200, body: { ok: true, rejected: true, reason: 'no_active_dispatch' } });
  await seedRunning(redis);
  await postResult(app);
  assert.strictEqual(await redis.get(KEY), null);
});

test('deduped ({ok:true, deduped:true}) → key KEPT for reconcile (dispatch check there)', async () => {
  const { app, redis } = setup({ status: 200, body: { ok: true, deduped: true } });
  await seedRunning(redis);
  await postResult(app);
  assert.ok(await redis.get(KEY), 'key must stay');
  assert.strictEqual(JSON.parse(await redis.get(KEY)).dispatch_id, 'disp-1');
});

test('backend 5xx on every retry → key KEPT', async () => {
  const { app, redis, posts } = setup({ status: 503, body: { error: 'x', retryable: true } });
  await seedRunning(redis);
  await postResult(app);
  assert.strictEqual(posts.length, 5);
  assert.ok(await redis.get(KEY));
});

test('2xx without a readable body → key KEPT', async () => {
  const { app, redis } = setup({ status: 200 });
  await seedRunning(redis);
  await postResult(app);
  assert.ok(await redis.get(KEY));
});

test('next IU of the same scene overwrote the key before the ACK → the newer copy is NOT deleted', async () => {
  const IU2 = 'book1_ch-1_sc-1_iu-bbbb:iu_image';
  const { app, redis } = setup((r) => {
    // Simulate the second IU's /task/result landing while the first POST is in flight.
    r.kv.set(KEY, JSON.stringify({ job_id: IU2, result_base64: 'BBBB', build_id: 'build1', dispatch_id: 'disp-1', protocol_version: PROTOCOL_VERSION }));
    return { status: 200, body: { ok: true } };
  });
  await seedRunning(redis);
  await postResult(app);
  const kept = await redis.get(KEY);
  assert.ok(kept, 'newer result copy must stay');
  assert.strictEqual(JSON.parse(kept).job_id, IU2);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); console.log(`  ok  - ${c.name}`); }
    catch (err) { failed++; console.log(`  FAIL - ${c.name}\n         ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n         ') : err}`); }
  }
  console.log(`result-ack: ${cases.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
