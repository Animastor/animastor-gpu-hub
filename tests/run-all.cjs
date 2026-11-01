#!/usr/bin/env node
'use strict';

/**
 * GPU Hub package test runner — standalone, ZERO external dependencies.
 *
 * Runs entirely inside the package boundary (no mocha, no backend helpers),
 * so `npm test` works in a fresh `npm ci` tree. Monorepo-side hub suites
 * (backend/tests/gpu-hub-*.test.js + tests/architecture/*) keep running
 * against the same sources — this runner ADDS package-boundary checks, it
 * does not replace the canonical suites.
 *
 * Check groups (Phase 10D):
 *   1. package smoke       — package identity + runtime modules load
 *   2. dependency isolation— no monorepo imports; frozen npm specifier set
 *   3. canonical contracts — protocol consumed from @animastor/contracts,
 *                            no local literal
 *   4. protocol parity     — hub vs worker vs contracts PROTOCOL_VERSION
 *   5. route freeze        — EXACT frozen 14-route HTTP surface
 *   6. Redis ownership     — hub-owned constants frozen; backend-owned
 *                            animastor:worker-auth never written by the hub
 *   7. artifact resolution — env overrides reach config, live mount beats
 *                            baked-in, configured-but-missing fails loudly;
 *                            public hub origin — canonical animastor.org
 *                            fallback, no stale .in literal
 *   8. bootstrap launcher  — piped execution, TTY, embedded context
 *   9. result ACK          — /task/result drops animastor:result:* on a
 *                            final backend ACK (tests/result-ack.cjs)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG_ROOT = path.resolve(__dirname, '..');
const RUNTIME_FILES = ['gpu-hub.js', 'server.js', 'tarball.js', 'bootstrap.js'];

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL - ${name}`);
    console.log(`         ${String(err && err.message ? err.message : err).split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
}

function listSourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

// ── 1. package smoke ─────────────────────────────────────────────────────

console.log('\n[1/9] package smoke');

check('package identity is @animastor/gpu-hub@0.1.0', () => {
  const pkg = readPkg();
  assert(pkg.name === '@animastor/gpu-hub', `name=${pkg.name}`);
  assert(pkg.version === '0.1.0', `version=${pkg.version}`);
});

check('package declares MIT license + node >= 18 engines', () => {
  const pkg = readPkg();
  assert(pkg.license === 'MIT', `license=${pkg.license}`);
  assert(pkg.engines && /18|20|>=/.test(String(pkg.engines.node)), 'engines.node missing');
});

check('LICENSE file present inside package boundary', () => {
  const src = readSource(path.join(PKG_ROOT, 'LICENSE'));
  assert(src.includes('MIT License'), 'LICENSE is not MIT');
  assert(src.includes('Animastor'), 'LICENSE copyright holder missing');
});

check('README.md present and covers required sections', () => {
  const src = readSource(path.join(PKG_ROOT, 'README.md'));
  for (const section of ['Standalone run', 'Required env', 'Exposed port', 'HTTP contract', 'Redis dependency', 'Backend callback', 'Job Protocol v2', 'Security warning']) {
    assert(src.includes(section), `README missing section: ${section}`);
  }
});

check('runtime modules load and expose the hub factory', () => {
  const hub = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  assert(typeof hub.buildHubApp === 'function', 'buildHubApp missing');
  assert(typeof hub.parseWorkerToken === 'function', 'parseWorkerToken missing');
  assert(typeof hub.PROTOCOL_VERSION === 'number', 'PROTOCOL_VERSION missing');
});

check('buildHubApp factory constructs with a stub Redis (no eager connections)', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const noop = () => {};
  const stub = { get: noop, set: noop, del: noop, hget: noop, hset: noop, llen: noop, keys: noop, expire: noop, hdel: noop, lpush: noop, rpush: noop, lrem: noop, lrange: noop, hgetall: noop, smembers: noop, sadd: noop, srem: noop, incr: noop, ttl: noop, pexpire: noop, multi: () => ({ exec: noop, llen: noop, lpush: noop, hset: noop, expire: noop }) };
  const app = buildHubApp({ redis: stub, config: {} });
  assert(typeof app === 'function', 'buildHubApp must return an express app');
  assert(app.__hub && typeof app.__hub.stopIntervals === 'function', 'hub internals (stopIntervals) not exposed');
});

// ── 2. dependency isolation ──────────────────────────────────────────────

console.log('\n[2/9] dependency isolation');

check('runtime files never require monorepo code (backend/worker/frontend/parent escapes)', () => {
  const banned = /require\(\s*['"][^'"]*(backend\/src|backend\/ai|worker\/worker|frontends|\.\.\/)+/;
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    if (banned.test(src)) offenders.push(file);
  }
  assert(offenders.length === 0, `monorepo requires in: ${offenders.join(', ')}`);
});

check('bare requires stay on the frozen npm specifier set + @animastor/contracts', () => {
  const allowed = new Set(['express', 'cors', 'crypto', 'fs', 'path', 'ioredis', 'zlib', 'http', 'https', 'url', '@animastor/contracts']);
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    for (const m of src.matchAll(/require\(\s*['"]([a-z@][^'"]*)['"]\s*\)/g)) {
      if (!allowed.has(m[1])) offenders.push(`${file}: ${m[1]}`);
    }
  }
  assert(offenders.length === 0, `new bare requires: ${offenders.join(', ')}`);
});

check('package.json declares exactly the frozen dependency set', () => {
  const pkg = readPkg();
  assert(JSON.stringify(Object.keys(pkg.dependencies || {}).sort()) === JSON.stringify(['@animastor/contracts', 'cors', 'express', 'ioredis']), 'unexpected dependencies');
  assert(!pkg.optionalDependencies, 'optionalDependencies removed — contracts is now a regular dependency');
  assert(!pkg.devDependencies, 'devDependencies appeared — keep the package runtime-only');
});

check('hub sources stay pg/postgres-free', () => {
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const src = readSource(path.join(PKG_ROOT, file));
    if (/\brequire\(['"]pg['"]\)|from ['"]pg['"]/.test(src)) offenders.push(file);
  }
  assert(offenders.length === 0, `pg requires in: ${offenders.join(', ')}`);
});

// ── 3. canonical contracts import ────────────────────────────────────────

console.log('\n[3/9] canonical contracts import');

check('gpu-hub.js consumes @animastor/contracts (the single protocol source)', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  assert(src.includes("require('@animastor/contracts')"), 'canonical import seam missing');
});

check('hub carries NO local PROTOCOL_VERSION literal', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  const literals = [...src.matchAll(/PROTOCOL_VERSION\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert(literals.length === 0, `local protocol literal(s) found: ${literals.join(', ')}`);
});

check('@animastor/contracts resolves inside the package tree (registry or provided node_modules)', () => {
  const resolved = require.resolve('@animastor/contracts', { paths: [PKG_ROOT] });
  assert(resolved.includes('@animastor/contracts'), `unexpected resolution: ${resolved}`);
});

// ── 4. protocol parity ───────────────────────────────────────────────────

console.log('\n[4/9] protocol parity');

check('hub PROTOCOL_VERSION equals the canonical @animastor/contracts value', () => {
  const hub = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const canonicalPkg = require(require.resolve('@animastor/contracts', { paths: [PKG_ROOT] }));
  const canonical = canonicalPkg.jobProtocolV2 || canonicalPkg;
  assert(hub.PROTOCOL_VERSION === canonical.PROTOCOL_VERSION, `hub=${hub.PROTOCOL_VERSION} canonical=${canonical.PROTOCOL_VERSION}`);
});

// ── 5. route freeze ──────────────────────────────────────────────────────

console.log('\n[5/9] route freeze');

check('route surface is EXACTLY the frozen 14-route set (additions and removals both fail)', () => {
  const FROZEN_ROUTES = [
    'POST /beacon', 'POST /task', 'GET /task/next', 'POST /task/result',
    'POST /task/error', 'GET /worker-source', 'GET /worker-bundle',
    'GET /worker-bundle/sha256', 'GET /workflow/:id', 'GET /installer',
    'GET /installer/bundle', 'GET /installer/sha256', 'GET /health',
    'DELETE /queue/clear',
  ].sort();
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  const found = [...src.matchAll(/app\.(post|get|delete|put)\(\s*"([^"]+)"/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    .sort();
  assert(JSON.stringify(found) === JSON.stringify(FROZEN_ROUTES),
    `route surface drifted.\nfound:    ${JSON.stringify(found)}\nfrozen:   ${JSON.stringify(FROZEN_ROUTES)}`);
});

check('deprecated /worker-source backward-compat markers intact', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  for (const marker of ['Deprecation', 'successor-version', 'worker_source_unavailable']) {
    assert(src.includes(marker), `missing marker: ${marker}`);
  }
});

// ── 6. Redis ownership ───────────────────────────────────────────────────

console.log('\n[6/9] Redis ownership');

check('hub-owned key constants keep their frozen values', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  for (const key of ['animastor:gpu-hub:workers', 'animastor:processing-claimed', 'animastor:dead-letter']) {
    assert(src.includes(`'${key}'`), `frozen key constant missing: ${key}`);
  }
});

check('hub NEVER writes the backend-owned animastor:worker-auth mirror', () => {
  const MIRROR_KEY = 'animastor:worker-auth';
  const writeOps = /\.(hset|hdel|del|set|expire|hsetnx)\s*\(/;
  const offenders = [];
  for (const file of RUNTIME_FILES) {
    const lines = readSource(path.join(PKG_ROOT, file)).split('\n');
    lines.forEach((line, i) => {
      if (writeOps.test(line) && line.includes(MIRROR_KEY)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert(offenders.length === 0, `mirror write ops: ${offenders.join(', ')}`);
});

check('hub still reads the mirror + SYNC anchors intact (frozen worker-auth debt)', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  for (const anchor of ['WORKER_AUTH_MIRROR_KEY', 'hget(WORKER_AUTH_MIRROR_KEY', 'SYNC: backend/src/services/worker-auth.js']) {
    assert(src.includes(anchor), `SYNC anchor missing: ${anchor}`);
  }
});

// ── 7. artifact directory resolution (Phase 10T precedence fix) ───────────

console.log('\n[7/9] artifact resolution + public hub origin');

function stubRedis() {
  const noop = () => {};
  return { get: noop, set: noop, del: noop, hget: noop, hset: noop, llen: noop, keys: noop, expire: noop, hdel: noop, lpush: noop, rpush: noop, lrem: noop, lrange: noop, hgetall: noop, smembers: noop, sadd: noop, srem: noop, incr: noop, ttl: noop, pexpire: noop, multi: () => ({ exec: noop, llen: noop, lpush: noop, hset: noop, expire: noop }) };
}

check('artifactDirEnvConfig forwards only non-empty artifact dir env keys', () => {
  const { artifactDirEnvConfig } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const out = artifactDirEnvConfig({
    WORKFLOW_DIR: ' /tmp/workflows ',
    INSTALLER_SRC_DIR: '',
    UNRELATED_KEY: '/tmp/x',
  });
  assert(out.WORKFLOW_DIR === '/tmp/workflows', `trimmed value expected, got ${JSON.stringify(out.WORKFLOW_DIR)}`);
  assert(!('INSTALLER_SRC_DIR' in out), 'empty env must stay absent (defaults apply)');
  assert(!('UNRELATED_KEY' in out), 'non-artifact keys must not leak into config');
});

check('explicit config override wins over every other source', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gpu-hub-artifacts-'));
  try {
    const app = buildHubApp({ redis: stubRedis(), config: { WORKFLOW_DIR: tmp }, intervals: false });
    assert(app.__hub.artifactDirs.WORKFLOW_DIR === tmp,
      `config override ignored: ${app.__hub.artifactDirs.WORKFLOW_DIR}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('configured-but-missing artifact dir fails loudly (no silent fallback)', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const missing = path.join(require('os').tmpdir(), 'gpu-hub-definitely-missing-dir');
  let threw = null;
  try {
    buildHubApp({ redis: stubRedis(), config: { WORKFLOW_DIR: missing }, intervals: false });
  } catch (err) { threw = err; }
  assert(threw, 'buildHubApp must refuse to start for a missing configured dir');
  assert(String(threw.message).includes('WORKFLOW_DIR'), `wrong error: ${threw.message}`);
});

check('live mount target beats baked-in artifacts/ (precedence fix)', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const artifactsDir = path.join(PKG_ROOT, 'artifacts');
  const bakedWorkflows = path.join(artifactsDir, 'workflows');
  const mounted = fs.existsSync('/app/workflows'); // inside a container with a real mount
  // Self-contained slate: a staged release tree (gitignored, produced by
  // scripts/stage-artifacts.cjs) may exist here — drop it and rebuild ONLY
  // the workflows group so both branches below are deterministic. If you
  // were preparing an image, re-stage after running the suite.
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.mkdirSync(bakedWorkflows, { recursive: true });
  try {
    const app = buildHubApp({ redis: stubRedis(), config: {}, intervals: false });
    const chosen = app.__hub.artifactDirs.WORKFLOW_DIR;
    if (mounted) {
      assert(chosen === '/app/workflows', `mount must win over baked-in, got ${chosen}`);
    } else {
      assert(chosen === bakedWorkflows,
        `baked-in must be used only when nothing is mounted, got ${chosen}`);
    }
    assert(app.__hub.artifactDirs.WORKER_BUNDLE_DIR === '/app/worker-bundle',
      'missing mount + missing baked-in must fall back to the frozen target (404 contract)');
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

check('publicHubUrl falls back to the canonical animastor.org origin', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const app = buildHubApp({ redis: stubRedis(), config: {}, intervals: false });
  assert(typeof app.__hub.publicHubUrl === 'function', 'publicHubUrl not exposed for tests');
  assert(app.__hub.publicHubUrl() === 'https://animastor.org/gpu',
    `no-request fallback: ${app.__hub.publicHubUrl()}`);
  assert(app.__hub.publicHubUrl({ headers: {} }) === 'https://animastor.org/gpu',
    'missing Host must fall back to the canonical origin');
  assert(app.__hub.publicHubUrl({ headers: { host: '127.0.0.1:5000' } }) === 'https://animastor.org/gpu',
    'non-DNS Host must fall back to the canonical origin');
  assert(app.__hub.publicHubUrl({ headers: { host: 'gpu.example.com' } }) === 'https://gpu.example.com/gpu',
    'clean Host must still win over the fallback');
});

check('config.PUBLIC_HUB_URL beats the forwarded Host (trailing slash trimmed)', () => {
  const { buildHubApp } = require(path.join(PKG_ROOT, 'gpu-hub.js'));
  const app = buildHubApp({
    redis: stubRedis(),
    config: { PUBLIC_HUB_URL: 'https://animastor.org/gpu/' },
    intervals: false,
  });
  assert(app.__hub.publicHubUrl({ headers: { host: 'gpu.example.com' } }) === 'https://animastor.org/gpu',
    `PUBLIC_HUB_URL ignored: ${app.__hub.publicHubUrl({ headers: { host: 'gpu.example.com' } })}`);
});

check('server.js forwards PUBLIC_HUB_URL into the hub config', () => {
  const src = readSource(path.join(PKG_ROOT, 'server.js'));
  assert(/PUBLIC_HUB_URL:\s*process\.env\.PUBLIC_HUB_URL/.test(src),
    'server.js must forward PUBLIC_HUB_URL (the env key is otherwise dead in the container)');
});

check('hub sources carry no stale animastor.in literal', () => {
  for (const file of ['gpu-hub.js', 'server.js', 'bootstrap.js', 'tarball.js']) {
    const src = readSource(path.join(PKG_ROOT, file));
    assert(!src.includes('animastor.in'), `stale domain literal in ${file}`);
  }
});

// ── 8. bootstrap launcher (curl | bash) ─────────────────────────────────

console.log('\n[8/9] bootstrap launcher (piped execution, TTY, embedded context)');

const { buildBootstrapScript, buildWindowsBootstrapScript } = require(path.join(PKG_ROOT, 'bootstrap.js'));
const { execFileSync, spawnSync } = require('child_process');

function bootScript(over = {}) {
  return buildBootstrapScript({
    hubUrl: 'https://animastor.org/gpu', profile: 'audio/qwen-tts', mode: 'existing',
    installerVersion: '0.2.0', hubVersion: '0.1.0', workerBundleVersion: '2.2.0', ...over,
  });
}

check('bootstrap is valid bash and runs entirely inside main() called on the last line', () => {
  const s = bootScript();
  execFileSync('bash', ['-n'], { input: s });
  const lines = s.trimEnd().split('\n');
  assert(lines[lines.length - 1] === 'main "$@"', `last line: ${lines[lines.length - 1]}`);
  assert(/^main\(\) \{$/m.test(s), 'main() wrapper');
});

check('bootstrap feeds the installer the terminal (never the piped script) and stops without one', () => {
  const s = bootScript();
  assert(s.includes('"${INSTALL_ARGS[@]}" "$@" </dev/tty'), 'installer stdin = /dev/tty when piped');
  assert(s.includes('elif { : </dev/tty; } 2>/dev/null; then'), 'tty probe');
  assert(s.includes('ERROR: no interactive terminal.'), 'clear no-TTY error');
  assert(!/scroll up/i.test(s), 'no "scroll up" — the installer prints the RESULT block');
});

check('bootstrap without a terminal and without --yes exits 3 before downloading anything', () => {
  const r = spawnSync('bash', ['-s'], {
    input: bootScript({ hubUrl: 'http://127.0.0.1:1/gpu' }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    detached: true, // no controlling terminal → /dev/tty unavailable
    timeout: 20000,
  });
  const out = String(r.stdout) + String(r.stderr);
  if (/No such device|Device not configured/.test(execFileSync('bash', ['-c', '{ : </dev/tty; } 2>&1 || true'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], detached: true }))) {
    assert(r.status === 3, `exit ${r.status}: ${out.slice(0, 300)}`);
    assert(out.includes('no interactive terminal'), out.slice(0, 300));
    assert(!out.includes('Downloading the Animastor installer bundle'), 'nothing downloaded');
  }
});

check('bootstrap embeds profile/mode, passes --hub-url, and an empty mode is NOT "managed"', () => {
  const s = bootScript();
  assert(s.includes('INSTALL_PROFILE="${ANIMASTOR_PROFILE:-audio/qwen-tts}"'));
  assert(s.includes('INSTALL_MODE="${ANIMASTOR_MODE:-existing}"'));
  assert(s.includes('INSTALL_ARGS=(install --profile "$INSTALL_PROFILE" --hub-url "$HUB_URL")'));
  assert(s.includes('[ -n "$INSTALL_MODE" ] && INSTALL_ARGS+=(--mode "$INSTALL_MODE")'), 'mode only when set');
  const noMode = bootScript({ mode: null });
  assert(noMode.includes('INSTALL_MODE="${ANIMASTOR_MODE:-}"'));
  assert(!noMode.split('\n').some((l) => !l.startsWith('#') && /--mode\s+"?managed/.test(l)), 'never a hard-coded managed');
  // user flags come after the embedded ones (last wins in the installer)
  assert(s.includes('"${INSTALL_ARGS[@]}" "$@"'));
});

check('bootstrap exports versions for the installer banner', () => {
  const s = bootScript();
  assert(s.includes('export ANIMASTOR_HUB_VERSION="0.1.0"'));
  assert(s.includes('export ANIMASTOR_WORKER_BUNDLE_VERSION="2.2.0"'));
  assert(/export ANIMASTOR_BOOTSTRAP_VERSION="\d+\.\d+\.\d+"/.test(s));
});

check('windows launcher: --hub-url, optional mode, no "scroll up"', () => {
  const ps = buildWindowsBootstrapScript({ hubUrl: 'https://animastor.org/gpu', profile: 'audio/qwen-tts', mode: null, installerVersion: '0.2.0' });
  assert(ps.includes("'--hub-url', $HubUrl"));
  assert(ps.includes("if ($InstallMode) { $installArgs += @('--mode', $InstallMode) }"));
  assert(!/scroll up/i.test(ps));
});

check('GET /installer embeds the hub version and the served worker bundle version', () => {
  const src = readSource(path.join(PKG_ROOT, 'gpu-hub.js'));
  assert(/hubVersion: HUB_PACKAGE_VERSION/.test(src));
  assert(/workerBundleVersion: workerBundleMeta\(\)\.version/.test(src));
});

// ── 9. result ACK (behavioural, separate async process) ──────────────────

console.log('\n[9/9] result ACK — fallback key lifecycle');

check('/task/result removes animastor:result:* on a final backend ACK, keeps it otherwise (tests/result-ack.cjs)', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'result-ack.cjs')], { encoding: 'utf8', timeout: 60000, env: process.env });
  process.stdout.write(String(r.stdout || '').split('\n').map((l) => l && `      ${l}`).join('\n'));
  assert(r.status === 0, `result-ack.cjs exit ${r.status}: ${String(r.stderr || '').slice(0, 400)}`);
});

// ── summary ──────────────────────────────────────────────────────────────

console.log(`\n========================================`);
console.log(` gpu-hub package tests: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

if (failed > 0) {
  for (const f of failures) {
    console.error(`\nFAIL: ${f.name}`);
    console.error(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  process.exit(1);
}
