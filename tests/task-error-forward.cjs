#!/usr/bin/env node
'use strict';

/**
 * /task/error forwarding of the optional structured error fields
 * (GPU retry policy, owner decision 2026-11-02; worker bundle 2.2.3).
 *
 * The worker may send `error_class` (deterministic | transient | oom) and
 * `comfy_status` (HTTP status of ComfyUI POST /prompt) next to `reason`. The
 * hub forwards them to backend POST /gpu/task/error unchanged after a shape
 * check; invalid values are dropped; a pre-2.2.3 worker (no fields) produces
 * the same body as before. Behavioural, in-process: real express app from
 * buildHubApp, in-memory Redis, stubbed backend fetch. Exit 0 = all passed.
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
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, String(v)); return 'OK'; },
    async del(...ks) { let n = 0; for (const k of ks) { if (kv.delete(k)) n++; } return n; },
    async hget(k, f) { const m = hashes.get(k); return m && m.has(f) ? m.get(f) : null; },
    async hset(k, f, v) { h(k).set(f, v); return 1; },
    async hdel(k, f) { const m = hashes.get(k); return m && m.delete(f) ? 1 : 0; },
    async lrem() { return 0; },
    async expire() { return 1; },
  };
}

function setup() {
  const redis = fakeRedis();
  const posts = [];
  const fetchImpl = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const app = buildHubApp({ redis, config: { BACKEND_URL: 'http://backend.invalid', GPU_HUB_API_KEY: 'k' }, fetchImpl, intervals: false });
  const secretHash = crypto.createHash('sha256').update(SECRET).digest('hex');
  redis.hset(WORKER_AUTH_MIRROR_KEY, secretHash, JSON.stringify({ worker_id: WORKER_ID, workspace_id: 'ws-1', worker_type: 'audio', mode: 'private' }));
  return { app, redis, posts };
}

const JOB = 'book1_ch-1_sc-1_0001:audio';

async function postError(app, redis, extra) {
  await redis.hset('animastor:running', JOB, JSON.stringify({
    dispatch_id: 'disp-1', worker: WORKER_ID, workspace_id: 'ws-1', stage: 'audio',
    book_id: 'book1', chapter_id: 'ch-1', scene_id: 'sc-1', job_type: 'audio', worker_mode: 'private',
  }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/task/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ job_id: JOB, build_id: 'build1', dispatch_id: 'disp-1', protocol_version: PROTOCOL_VERSION, reason: 'No prompt_id: invalid_prompt', ...extra }),
    });
    return res.status;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('2.2.3 worker: error_class + comfy_status forwarded to backend', async () => {
  const { app, redis, posts } = setup();
  assert.strictEqual(await postError(app, redis, { error_class: 'deterministic', comfy_status: 400 }), 200);
  assert.strictEqual(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/gpu/task/error'));
  assert.strictEqual(posts[0].body.error_class, 'deterministic');
  assert.strictEqual(posts[0].body.comfy_status, 400);
  assert.strictEqual(posts[0].body.reason, 'No prompt_id: invalid_prompt');
});

test('pre-2.2.3 worker: no fields → body without error_class / comfy_status', async () => {
  const { app, redis, posts } = setup();
  await postError(app, redis, {});
  assert.ok(!('error_class' in posts[0].body));
  assert.ok(!('comfy_status' in posts[0].body));
});

test('invalid values are dropped, never invented', async () => {
  const { app, redis, posts } = setup();
  await postError(app, redis, { error_class: 'retry-forever', comfy_status: 'x' });
  assert.ok(!('error_class' in posts[0].body));
  assert.ok(!('comfy_status' in posts[0].body));
  const s2 = setup();
  await postError(s2.app, s2.redis, { error_class: 'OOM', comfy_status: 999 });
  assert.strictEqual(s2.posts[0].body.error_class, 'oom');
  assert.ok(!('comfy_status' in s2.posts[0].body));
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
