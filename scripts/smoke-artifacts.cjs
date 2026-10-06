#!/usr/bin/env node
'use strict';

/**
 * In-image artifact release gate — runs INSIDE the built image:
 *   docker run --rm <image> node /app/scripts/smoke-artifacts.cjs
 * (with the hub + redis running, e.g. from the CI smoke network).
 *
 * Asserts the RUNNING hub serves exactly what artifacts.lock.json pins
 * (worker/workflow/installer versions + baked bytes). CI fails on any drift,
 * so a stale or missing baked artifact can never ship silently.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts.lock.json'), 'utf8'));
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5000';

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : 'FAIL -'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + p, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Pick the first allowlisted workflow id+file from the BAKED install
// manifests — no hardcoded filename, so a pin bump cannot silently rot.
function pickWorkflow() {
  const manifestsRoot = path.join(ROOT, 'artifacts', 'install-manifests');
  for (const type of fs.readdirSync(manifestsRoot).sort()) {
    const typeDir = path.join(manifestsRoot, type);
    if (!fs.statSync(typeDir).isDirectory()) continue;
    for (const file of fs.readdirSync(typeDir).sort()) {
      if (!file.endsWith('.json')) continue;
      let m = null;
      try {
        m = JSON.parse(fs.readFileSync(path.join(typeDir, file), 'utf8'));
      } catch (_) {
        continue;
      }
      const arts = m && m.workflows && Array.isArray(m.workflows.artifacts) ? m.workflows.artifacts : [];
      const wf = arts.find((a) => a && a.id && a.filename);
      if (wf) return { id: String(wf.id).replace(/^workflow:/, ''), filename: wf.filename };
    }
  }
  return null;
}

(async () => {
  const health = await get('/health');
  check('health 200', health.status === 200, `status=${health.status}`);

  const wLock = lock.artifacts['worker-bundle'];
  const wb = JSON.parse((await get('/worker-bundle/sha256')).body.toString());
  check(
    'worker-bundle version == lock',
    wb.version === wLock.version,
    `served=${wb.version} lock=${wLock.version}`
  );
  check(
    'worker-bundle file count == lock',
    Array.isArray(wb.files) && wb.files.length === wLock.files,
    `served=${wb.files && wb.files.length} lock=${wLock.files}`
  );

  const iLock = lock.artifacts['installer-src'];
  const inst = JSON.parse((await get('/installer/sha256')).body.toString());
  check(
    'installer version == lock',
    inst.version === iLock.version,
    `served=${inst.version} lock=${iLock.version}`
  );

  const wf = pickWorkflow();
  check('allowlisted workflow found in baked manifests', !!wf, wf ? wf.id : 'none');
  if (wf) {
    const res = await get(`/workflow/${encodeURIComponent(wf.id)}`);
    const bakedFile = path.join(ROOT, 'artifacts', 'workflows', wf.filename);
    const bakedSha = sha256(fs.readFileSync(bakedFile));
    const servedSha = res.headers['x-animastor-sha256'] || '';
    check(
      'workflow served bytes == baked (pinned) bytes',
      res.status === 200 && servedSha === bakedSha,
      `served=${servedSha.slice(0, 16)} baked=${bakedSha.slice(0, 16)} status=${res.status}`
    );
  }

  if (failed) {
    console.error(`smoke-artifacts: ${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log('smoke-artifacts: all checks passed');
})().catch((err) => {
  console.error('smoke-artifacts error:', err.message);
  process.exit(1);
});
