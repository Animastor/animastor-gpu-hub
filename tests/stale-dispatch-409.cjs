#!/usr/bin/env node
'use strict';

/**
 * v0.2.9 — a rejected result is never lost silently
 * (reports/2026-11-04/regenerate-sweep-fix.md, GPU_HUB_CONTRACT.md §8.5).
 *
 *  - 409 stale_or_unknown_dispatch carries `detail`
 *    (no_running_record | dispatch_mismatch) + job_id / dispatch_id;
 *  - no_running_record → ONE backend signal per dispatch×job through
 *    POST /gpu/task/error (reason stale_dispatch_result, error_class
 *    transient, hub_detail no_running_record); the result is NOT stored;
 *  - dispatch_mismatch → no signal (the current dispatch is alive);
 *  - backend unreachable → fallback key animastor:error:{job_id};
 *  - idle worker: /beacon alone writes animastor:worker:heartbeat:* (EX 30)
 *    with no current job (§9.3 of the 2026-11-04 stall report).
 *
 * Behavioural, in-process: real express app from buildHubApp, in-memory
 * Redis (honours SET NX / EX), stubbed backend fetch. Exit 0 = all passed.
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
  const ttl = new Map();
  const hashes = new Map();
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  return {
    kv, ttl, hashes,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v, ...args) {
      const up = args.map((a) => String(a).toUpperCase());
      if (up.includes('NX') && kv.has(k)) return null;
      kv.set(k, String(v));
      const ex = up.indexOf('EX');
      if (ex >= 0) ttl.set(k, Number(args[ex + 1]));
      return 'OK';
    },
    async del(...ks) { let n = 0; for (const k of ks) { if (kv.delete(k)) n++; } return n; },
    async hget(k, f) { const m = hashes.get(k); return m && m.has(f) ? m.get(f) : null; },
    async hset(k, f, v) { h(k).set(f, v); return 1; },
    async hdel(k, f) { const m = hashes.get(k); return m && m.delete(f) ? 1 : 0; },
    async hgetall(k) { const m = hashes.get(k); return m ? Object.fromEntries(m) : {}; },
    async lrem() { return 0; },
    async expire() { return 1; },
    async eval() { return 0; },
  };
}

function setup({ backendDown = false } = {}) {
  const redis = fakeRedis();
  const posts = [];
  const fetchImpl = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    if (backendDown) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const app = buildHubApp({ redis, config: { BACKEND_URL: 'http://backend.invalid', GPU_HUB_API_KEY: 'k' }, fetchImpl, intervals: false });
  const secretHash = crypto.createHash('sha256').update(SECRET).digest('hex');
  redis.hset(WORKER_AUTH_MIRROR_KEY, secretHash, JSON.stringify({ worker_id: WORKER_ID, workspace_id: 'ws-1', worker_type: 'image', mode: 'private' }));
  return { app, redis, posts };
}

const JOB = 'book1_ch-1_sc-7_iu-677669ab:iu_image';

function running(dispatchId) {
  return JSON.stringify({
    dispatch_id: dispatchId, worker: WORKER_ID, workspace_id: 'ws-1', stage: 'image',
    book_id: 'book1', chapter_id: 'ch-1', scene_id: 'sc-7', job_type: 'image', worker_mode: 'private',
  });
}

async function call(app, route, body) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const resultBody = (dispatchId) => ({ job_id: JOB, build_id: 'build1', dispatch_id: dispatchId, protocol_version: PROTOCOL_VERSION, result_base64: 'data:image/png;base64,AAAA' });
const errorBody = (dispatchId) => ({ job_id: JOB, build_id: 'build1', dispatch_id: dispatchId, protocol_version: PROTOCOL_VERSION, reason: 'Hub rejected result: HTTP 409' });

/** Background signal delivery → wait until `n` posts arrived (or time out). */
async function waitPosts(posts, n, ms = 2000) {
  const end = Date.now() + ms;
  while (posts.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
const settle = () => new Promise((r) => setTimeout(r, 100));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('/task/result without running record → 409 detail=no_running_record + job_id/dispatch_id', async () => {
  const { app, posts } = setup();
  const r = await call(app, '/task/result', resultBody('disp-1'));
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body, { error: 'stale_or_unknown_dispatch', detail: 'no_running_record', job_id: JOB, dispatch_id: 'disp-1' });
  await waitPosts(posts, 1);
  assert.strictEqual(posts.length, 1, 'exactly one backend signal');
});

test('no_running_record → backend signal: /gpu/task/error stale_dispatch_result, transient, result NOT stored', async () => {
  const { app, redis, posts } = setup();
  await call(app, '/task/result', resultBody('disp-1'));
  await waitPosts(posts, 1);
  const p = posts[0];
  assert.ok(p.url.endsWith('/gpu/task/error'), p.url);
  assert.strictEqual(p.body.job_id, JOB);
  assert.strictEqual(p.body.dispatch_id, 'disp-1');
  assert.strictEqual(p.body.build_id, 'build1');
  assert.strictEqual(p.body.reason, 'stale_dispatch_result');
  assert.strictEqual(p.body.error_class, 'transient');
  assert.strictEqual(p.body.hub_detail, 'no_running_record');
  assert.strictEqual(p.body.source, 'task_result');
  assert.strictEqual(p.body.worker_id, WORKER_ID);
  assert.strictEqual(p.body.workspace_id, 'ws-1');
  assert.strictEqual(p.body.protocol_version, PROTOCOL_VERSION);
  const resultKeys = [...redis.kv.keys()].filter((k) => k.startsWith('animastor:result:'));
  assert.deepStrictEqual(resultKeys, [], 'an orphan result is never stored');
});

test('result 409 then task/error 409 for the same dispatch → still ONE signal (dedup per dispatch×job)', async () => {
  const { app, posts } = setup();
  await call(app, '/task/result', resultBody('disp-1'));
  await waitPosts(posts, 1);
  const e = await call(app, '/task/error', errorBody('disp-1'));
  assert.strictEqual(e.status, 409);
  assert.strictEqual(e.body.detail, 'no_running_record');
  await settle();
  assert.strictEqual(posts.length, 1);
});

test('/task/error first without running record → signal with source=task_error', async () => {
  const { app, posts } = setup();
  const e = await call(app, '/task/error', errorBody('disp-2'));
  assert.strictEqual(e.status, 409);
  await waitPosts(posts, 1);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body.reason, 'stale_dispatch_result');
  assert.strictEqual(posts[0].body.source, 'task_error');
});

test('dispatch_mismatch (job re-dispatched) → 409 detail=dispatch_mismatch, NO signal, running record kept', async () => {
  const { app, redis, posts } = setup();
  await redis.hset('animastor:running', JOB, running('disp-NEW'));
  const r = await call(app, '/task/result', resultBody('disp-OLD'));
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body, { error: 'stale_or_unknown_dispatch', detail: 'dispatch_mismatch', job_id: JOB, dispatch_id: 'disp-OLD' });
  const e = await call(app, '/task/error', errorBody('disp-OLD'));
  assert.strictEqual(e.body.detail, 'dispatch_mismatch');
  await settle();
  assert.strictEqual(posts.length, 0);
  assert.ok(await redis.hget('animastor:running', JOB), 'the live claim is untouched');
});

test('matching running record → unchanged happy path (200, result delivered to /gpu/task/result)', async () => {
  const { app, redis, posts } = setup();
  await redis.hset('animastor:running', JOB, running('disp-1'));
  const r = await call(app, '/task/result', resultBody('disp-1'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/gpu/task/result'));
});

test('backend unreachable → fallback animastor:error:{job_id} with reason stale_dispatch_result', async () => {
  const { app, redis, posts } = setup({ backendDown: true });
  await call(app, '/task/result', resultBody('disp-3'));
  const end = Date.now() + 6000;
  while (!redis.kv.has(`animastor:error:${JOB}`) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const raw = redis.kv.get(`animastor:error:${JOB}`);
  assert.ok(raw, 'fallback key written');
  const v = JSON.parse(raw);
  assert.strictEqual(v.reason, 'stale_dispatch_result');
  assert.strictEqual(v.dispatch_id, 'disp-3');
  assert.strictEqual(v.error_class, 'transient');
  assert.strictEqual(v.hub_detail, 'no_running_record');
  assert.strictEqual(posts.length, 5, 'regular 5 delivery attempts');
});

test('idle worker: /beacon alone writes the heartbeat (EX 30, no current job) — §9.3', async () => {
  const { app, redis } = setup();
  const r = await call(app, '/beacon', { gpu: 'V100', vram: '16 GB', version: '2.3.0', protocol_version: PROTOCOL_VERSION });
  assert.strictEqual(r.status, 200);
  const key = `animastor:worker:heartbeat:image:${WORKER_ID}`;
  const hb = JSON.parse(redis.kv.get(key));
  assert.strictEqual(redis.ttl.get(key), 30);
  assert.strictEqual(hb.worker_id, WORKER_ID);
  assert.strictEqual(hb.mode, 'private');
  assert.strictEqual(hb.workspace_id, 'ws-1');
  assert.ok(!hb.current_job_id, 'idle — no current job');
  assert.ok(typeof hb.ts === 'number');
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
