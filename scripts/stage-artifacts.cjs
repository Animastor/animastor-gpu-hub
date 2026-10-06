#!/usr/bin/env node
'use strict';

/**
 * Post-split GPU Hub artifact staging — the ONLY way artifacts/ is produced.
 *
 * Scheme (pinned source -> deterministic staging -> docker build):
 *   artifacts.lock.json pins each artifact group to { repository, commit } of
 *   its canonical post-split source repo. This script
 *     1. verifies every source checkout is a git checkout AT the pinned commit,
 *     2. copies the groups into artifacts/<name>/ (fresh, nothing stale),
 *     3. re-hashes the staged bytes with the canonical tree formula
 *          sha256 over sorted "<sha256(file)>  <relpath>\n" lines (LF),
 *        and compares digest/file-count/version against the lock.
 * Any mismatch exits 1 — CI fails instead of baking a stale artifact
 * (no silent fallback, ever).
 *
 * Usage:
 *   node scripts/stage-artifacts.cjs --worker <checkout> --backend <checkout>
 *   node scripts/stage-artifacts.cjs --write-lock --worker <checkout> --backend <checkout>
 *
 * --write-lock regenerates artifacts.lock.json from the given checkouts'
 * HEADs (maintainer action when INTENTIONALLY bumping a pin — the new pin is
 * a reviewed code change like any other).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(ROOT, 'artifacts.lock.json');
const OUT_DIR = path.join(ROOT, 'artifacts');

// Structural staging rules (code — reviewed). Pins and digests live in
// artifacts.lock.json. Layout mirrors what the image bakes under
// /app/artifacts/<name>.
const GROUPS = [
  {
    name: 'worker-bundle',
    source: 'worker',
    dir: 'packages/animastor-worker/worker',
    extra: [],
    versionFile: 'package.json',
  },
  {
    name: 'workflows',
    source: 'backend',
    dir: 'backend/ai/workflows',
    extra: [],
    versionFile: null,
  },
  {
    // Flattened: src/installer/* at the root + canonical package.json from
    // the package root (same layout as the monorepo stager and as the
    // verified production bake-in).
    name: 'installer-src',
    source: 'backend',
    dir: 'packages/animastor-installer/src/installer',
    extra: [{ from: 'packages/animastor-installer/package.json', to: 'package.json' }],
    versionFile: 'package.json',
  },
  {
    name: 'install-manifests',
    source: 'backend',
    dir: 'packages/animastor-installer/ai/install-manifests',
    extra: [],
    versionFile: null,
  },
];

const SKIP_DIRS = new Set(['node_modules', '.git']);

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function parseArgs(argv) {
  const out = { writeLock: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write-lock') out.writeLock = true;
    else if (argv[i] === '--worker') out.worker = argv[++i];
    else if (argv[i] === '--backend') out.backend = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`${dir} is not a git checkout (${err.message.split('\n')[0]})`);
  }
}

// Canonical staged file list for a group: sorted relative paths (posix
// separators), skipping vendored/VCS dirs.
function listGroupFiles(root, extra) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  for (const x of extra) files.push(x.to);
  return files.sort();
}

// Digest formula: sha256 over sorted "<sha256(file)>  <relpath>\n" lines.
function treeDigest(entries /* [{rel, abs}] sorted by rel */) {
  const h = crypto.createHash('sha256');
  for (const f of entries) h.update(`${sha256File(f.abs)}  ${f.rel}\n`);
  return h.digest('hex');
}

function groupEntries(g, sourceRoot) {
  const srcRoot = path.join(sourceRoot, g.dir);
  if (!fs.existsSync(srcRoot)) throw new Error(`missing source dir: ${srcRoot}`);
  const rels = listGroupFiles(srcRoot, g.extra);
  return rels.map((rel) => ({
    rel,
    abs: g.extra.some((x) => x.to === rel)
      ? path.join(sourceRoot, g.extra.find((x) => x.to === rel).from)
      : path.join(srcRoot, rel),
  }));
}

function stageGroup(g, sourceRoot) {
  const entries = groupEntries(g, sourceRoot);
  const destRoot = path.join(OUT_DIR, g.name);
  fs.mkdirSync(destRoot, { recursive: true });
  for (const e of entries) {
    const dest = path.join(destRoot, e.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(e.abs, dest);
  }
  return entries;
}

function readVersion(g, stagedRoot) {
  if (!g.versionFile) return null;
  const p = path.join(stagedRoot, g.versionFile);
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!pkg.version) throw new Error(`no version in ${p}`);
  return pkg.version;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.worker || !args.backend) {
    console.error('usage: stage-artifacts.cjs --worker <checkout> --backend <checkout> [--write-lock]');
    process.exit(2);
  }
  const sources = { worker: args.worker, backend: args.backend };
  const heads = {};
  for (const [k, dir] of Object.entries(sources)) heads[k] = gitHead(dir);

  const lock = args.writeLock ? null : JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const failures = [];

  // 1. pin check: every checkout must be EXACTLY at the locked commit
  if (lock) {
    for (const [k, meta] of Object.entries(lock.sources || {})) {
      if (heads[k] !== meta.commit) {
        failures.push(`source ${k}: HEAD ${heads[k]} != pinned ${meta.commit} (${meta.repository})`);
      } else {
        console.log(`source ${k}: ${meta.repository} @ ${meta.commit.slice(0, 12)} OK`);
      }
    }
    for (const k of Object.keys(sources)) {
      if (!lock.sources || !lock.sources[k]) failures.push(`source ${k}: missing from lock`);
    }
  }

  // 2. fresh staging (never reuse a previous artifacts/ tree)
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const produced = {};
  for (const g of GROUPS) {
    const entries = stageGroup(g, sources[g.source]);
    const stagedRoot = path.join(OUT_DIR, g.name);
    produced[g.name] = {
      files: entries.length,
      sha256_tree: treeDigest(entries),
      version: readVersion(g, stagedRoot),
    };
  }

  // 3. verify against the lock (or write a fresh one)
  if (args.writeLock) {
    const next = {
      _comment:
        'Pinned post-split artifact sources for the GPU Hub release build — ' +
        'generated by scripts/stage-artifacts.cjs --write-lock, reviewed like code. ' +
        'Digest formula: sha256 over sorted "<sha256(file)>  <relpath>\\n" lines (LF). ' +
        'CI stages these exact bytes (scripts/stage-artifacts.cjs) and FAILS on any mismatch.',
      formula: 'sha256 over sorted "<sha256(file)>  <relpath>\\n" lines (LF, C-locale byte order)',
      sources: {},
      artifacts: {},
    };
    for (const [k, dir] of Object.entries(sources)) {
      const url = `https://github.com/Animastor/animastor-${k === 'worker' ? 'worker' : 'backend'}`;
      const repoSlug = `Animastor/animastor-${k === 'worker' ? 'worker' : 'backend'}`;
      next.sources[k] = { repository: repoSlug, url, commit: heads[k] };
    }
    for (const g of GROUPS) {
      next.artifacts[g.name] = { source: g.source, path: g.dir, ...produced[g.name] };
    }
    fs.writeFileSync(LOCK_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`artifacts.lock.json written (${LOCK_PATH})`);
  } else {
    for (const g of GROUPS) {
      const want = (lock.artifacts || {})[g.name];
      const got = produced[g.name];
      if (!want) {
        failures.push(`${g.name}: missing from lock`);
        continue;
      }
      if (want.sha256_tree !== got.sha256_tree) {
        failures.push(`${g.name}: sha256_tree mismatch staged=${got.sha256_tree} lock=${want.sha256_tree}`);
      }
      if (want.files !== got.files) {
        failures.push(`${g.name}: file count mismatch staged=${got.files} lock=${want.files}`);
      }
      if (want.version && want.version !== got.version) {
        failures.push(`${g.name}: version mismatch staged=${got.version} lock=${want.version}`);
      }
    }
    for (const name of Object.keys(lock.artifacts || {})) {
      if (!GROUPS.some((g) => g.name === name)) failures.push(`lock group ${name} has no staging rule`);
    }
  }

  for (const g of GROUPS) {
    const p = produced[g.name];
    console.log(`  ${g.name}: files=${p.files} version=${p.version || '-'} sha256_tree=${p.sha256_tree}`);
  }

  if (failures.length) {
    console.error('\nSTAGING FAILED — refusing to produce an image from mismatched artifacts:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(args.writeLock ? 'lock written from pinned checkouts' : 'staging verified against artifacts.lock.json');
}

main();
