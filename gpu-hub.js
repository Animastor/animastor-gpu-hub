// ======================================================
// GPU HUB - v0.2.0 (Fail-closed worker authorization — PW-4)
// + protocol 3 relay /v3/* (ORCHESTRATION_V2 stage 1c); /queue/clear scoped only
// ======================================================
// Workspace-aware job ownership, FAIL CLOSED:
//   - worker identity comes ONLY from a Bearer credential resolved via the
//     backend-maintained Redis mirror `animastor:worker-auth` (hub has no pg);
//     NO CREDENTIAL → 401 on every worker-facing endpoint. There is no
//     uncredentialed lane: a missing/invalid credential never becomes
//     SYSTEM or SHARE — it is UNAUTHORIZED and gets nothing.
//   - three registry modes: private (serves only its workspace queue),
//     share (community pool) and system (Animastor-operated pool); share and
//     system pop the workspace-less system pool, private pops its own queue;
//   - the backend resolves `book → workspace` at dispatch and passes
//     workspace_id in /task (key-gated) → hub enqueues to
//     `queue:{type}:ws:{workspace}`; the system pool (`queue:{type}`) serves
//     share/system workers and workspaces without a private worker;
//   - the claim binds the running record to the authenticated worker +
//     workspace; /task/result and /task/error are claimer-only;
//   - poison-write cross-check on pop; `processing` orphan sweep requeues
//     crashed claims back to the correct queue (capped, then backend error).
// The hub stays a dumb transport: ownership is DATA (workspace_id authored by
// the backend), never hub policy and never client-supplied.

const express = require("express")
const cors = require("cors")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const zlib = require("zlib")
const { buildTarGz, walkDir } = require("./tarball")
const { buildBootstrapScript, buildWindowsBootstrapScript, BOOTSTRAP_VERSION } = require("./bootstrap")

// Job Protocol v2 — @animastor/contracts is the SINGLE canonical runtime
// source (contracts/src/job-protocol-v2.js; normative spec:
// docs/architecture/JOB_PROTOCOL_V2.md). Phase 10B: the hub consumes the
// canonical package and carries NO local protocol implementation/literal.
// Resolution: repo-root node_modules symlink locally; inside the container
// the docker-compose service mounts ./contracts read-only at
// /app/node_modules/@animastor/contracts (same seam as the backend facade).
const { PROTOCOL_VERSION } = require('@animastor/contracts').jobProtocolV2;

// ======================================================
// CONSTANTS
// ======================================================

// SYNC: backend/src/services/worker-auth.js — mirror key + value shape
// ({ worker_id, workspace_id, worker_type, mode, name }).
const WORKER_AUTH_MIRROR_KEY = 'animastor:worker-auth';
// Claim bookkeeping for the processing orphan sweep (job_id → claim JSON).
const PROCESSING_CLAIMED_KEY = 'animastor:processing-claimed';
// Poison / requeue-limit entries land here (kept for audit, never requeued).
const DEAD_LETTER_KEY = 'animastor:dead-letter';
// A processing entry without a running record is requeued only after this
// grace — covers the rpoplpush→hset crash window and sweep/read races.
const ORPHAN_GRACE_MS = Number(process.env.ORPHAN_GRACE_MS || 60000);
// Cap requeues of the same orphaned task; afterwards it is dead-lettered and
// reported to the backend (the scheduler re-dispatches via lease expiry).
const MAX_ORPHAN_REQUEUES = Number(process.env.MAX_ORPHAN_REQUEUES || 3);

const SYSTEM_JOB_TYPES = ['audio', 'image', 'video'];

// ======================================================
// WORKER TOKEN (mirror fast-path)
// ======================================================
// SYNC: backend/src/storage/postgres/repositories/worker-repo.js — token
// format `wrk.<worker_id_b64url>.<secret_b64url>`; the mirror field is the
// SHA-256 of the secret. The hub NEVER resolves identity from query/body.

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Parse a raw worker token → { workerId, secretHash } or null. */
function parseWorkerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'wrk') return null;
  try {
    const workerId = b64urlDecode(parts[1]).toString('utf8');
    const secret = b64urlDecode(parts[2]);
    if (!workerId || secret.length === 0) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerId)) return null;
    return { workerId, secretHash: sha256(secret) };
  } catch (_) {
    return null;
  }
}

/** Authorization header only — tokens are never accepted in query/body. */
function extractBearerToken(req) {
  const header = req && req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Resolve a worker credential via the Redis auth mirror. FAIL CLOSED:
 * malformed token, missing mirror entry, corrupt JSON, worker_id mismatch or
 * missing ownership all yield null — never an identity.
 *
 * Ownership model (PW-4): private/share identities MUST carry a workspace;
 * only mode='system' (Animastor-operated pool) is workspace-less. A missing
 * credential is NEVER system/share — it is UNAUTHORIZED (caller answers 401).
 * @returns {Promise<{worker_id,workspace_id,worker_type,mode,name}|null>}
 */
async function authenticateWorkerMirror(redis, token) {
  const parsed = parseWorkerToken(token);
  if (!parsed) return null;
  try {
    const raw = await redis.hget(WORKER_AUTH_MIRROR_KEY, parsed.secretHash);
    if (!raw) return null;
    const identity = JSON.parse(raw);
    if (!identity || typeof identity !== 'object') return null;
    // Cross-check the mirror value against the token's self-locator.
    if (identity.worker_id !== parsed.workerId) return null;
    if (!identity.worker_type) return null;
    if (identity.mode !== 'system' && !identity.workspace_id) return null;
    // SH-1: the optional share_policy fact rides the mirror (D4). Fail
    // closed on any malformed shape and re-check expiry ON READ — a stale
    // mirror can never extend a policy past its expires_at (§7.2).
    identity.share_policy = sanitizeSharePolicy(identity.share_policy);
    return identity;
  } catch (_) {
    return null;
  }
}

/**
 * SH-1/SH-2: validate the mirror's optional share_policy payload.
 *   share_policy: { policy_id, scope_kind: 'public'|'users', expires_at: ms|null }
 * V2 admits BOTH scopes (public = spare capacity for the system pool;
 * users = spare capacity for the policy's own granted audience lane).
 * Any other shape/scope fails closed; expiry is re-checked against the
 * local clock on EVERY auth resolution — an expired (stale) mirror entry
 * is treated as "no policy" and can never extend sharing (the backend
 * periodic resync + point updates are the transport; PG is the source of
 * truth).
 * @returns {object|null}
 */
function sanitizeSharePolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.policy_id !== 'string' || !raw.policy_id) return null;
  if (raw.scope_kind !== 'public' && raw.scope_kind !== 'users') return null;
  if (raw.expires_at != null && typeof raw.expires_at !== 'number') return null;
  const policy = {
    policy_id: raw.policy_id,
    scope_kind: raw.scope_kind,
    expires_at: raw.expires_at != null ? Number(raw.expires_at) : null,
  };
  return activeSharePolicy(policy);
}

/**
 * Expiry re-check on read (§7.2): a policy is active only while
 * `expires_at` is in the future (or NULL = "until stopped"). Composed with
 * the kill-switch + private-mode gate by callers — this function is the
 * single point that can never be fooled by a stale mirror timestamp.
 * @returns {object|null}
 */
function activeSharePolicy(policy, now = Date.now()) {
  if (!policy) return null;
  if (policy.expires_at != null && Number(policy.expires_at) <= now) return null;
  return policy;
}

/**
 * FAIL-CLOSED worker gate for the worker-facing endpoints. No Bearer
 * credential → 401 (there is no uncredentialed lane); an invalid/revoked
 * one → 401 as well. Returns the registry identity or null after answering.
 * @returns {Promise<object|null>}
 */
async function requireWorkerCredential(redis, req, res) {
  const token = extractBearerToken(req);
  if (!token) {
    return (res.status(401).json({
      error: 'worker_authentication_failed',
      message: 'Worker authentication failed — check ANIMASTOR_WORKER_TOKEN',
    }), null);
  }
  const auth = await authenticateWorkerMirror(redis, token);
  if (!auth) {
    return (res.status(401).json({ error: 'invalid_worker_credential' }), null);
  }
  // access log (v0.3.3): the token-derived worker id, never the token itself
  if (res && res.locals) res.locals.hubWorkerId = auth.worker_id || null;
  return auth;
}

// ======================================================
// ACCESS LOG (v0.3.3, reports/2026-11-07/orch-v2-image-scene-run.md О3)
// ======================================================
// One line per request: method, path (no query string), status, worker_id
// (token-derived), duration. Never headers, bodies or the query string
// (tokens / keys / user data). Idle traffic — an EMPTY task poll
// ({"task":null} from /task/next and /v3/task/next), a 2xx beacon and
// /health — is not logged one by one but folded into one summary line per
// interval (default 60 s), so the log shows work, errors and rejections.
const ACCESS_SUMMARY_MS = 60_000;
const EMPTY_POLL_BODY = '{"task":null}';
const IDLE_PATHS = new Set(['/beacon', '/v3/beacon', '/health']);

function createAccessLog({ log = (line) => console.log(line), now = () => Date.now() } = {}) {
  let idle = new Map();       // "METHOD path status" → count
  let idleWorkers = new Set();
  let since = now();

  function middleware(req, res, next) {
    const start = now();
    const origSend = res.send;
    res.send = function sendTap(body) {
      try {
        const text = typeof body === 'string' ? body : (Buffer.isBuffer(body) ? body.toString('utf8', 0, 64) : null);
        if (text !== null && text.trim() === EMPTY_POLL_BODY) res.locals.hubEmptyPoll = true;
      } catch (_) { /* never breaks the response */ }
      return origSend.call(this, body);
    };
    res.on('finish', () => {
      try {
        const p = String(req.path || req.originalUrl || '').split('?')[0];
        const workerId = (res.locals && res.locals.hubWorkerId) || null;
        const status = res.statusCode;
        const isIdle = (res.locals && res.locals.hubEmptyPoll === true && status === 200)
          || (IDLE_PATHS.has(p) && status >= 200 && status < 300);
        if (isIdle) {
          const k = `${req.method} ${p}${res.locals && res.locals.hubEmptyPoll ? ' empty' : ` ${status}`}`;
          idle.set(k, (idle.get(k) || 0) + 1);
          if (workerId) idleWorkers.add(workerId);
          return;
        }
        log(`[HTTP] ${req.method} ${p} → ${status} worker=${workerId || '-'} ${Math.max(0, now() - start)}ms`);
      } catch (_) { /* logging never breaks the hub */ }
    });
    next();
  }

  /** Print (and reset) the idle summary; nothing when there was no idle traffic. */
  function flush() {
    const t = now();
    if (idle.size > 0) {
      const parts = [...idle.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ×${n}`);
      log(`[HTTP] idle ${Math.round((t - since) / 1000)}s: ${parts.join(', ')} (workers ${idleWorkers.size})`);
    }
    idle = new Map();
    idleWorkers = new Set();
    since = t;
  }

  return { middleware, flush };
}

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ======================================================
// ARTIFACT DIR ENV → CONFIG FORWARDING
// ======================================================
// server.js used to build `config` by hand and silently dropped these keys,
// which made the config-override branch of resolveArtifactDir() unreachable
// inside a shipped container (verified: WORKER_BUNDLE_DIR=... changed
// nothing). Both entrypoints spread this helper into `config` so an explicit
// env override is always honored (and fails loudly when it points nowhere).
const ARTIFACT_DIR_ENV_KEYS = [
  "WORKER_BUNDLE_DIR",
  "WORKFLOW_DIR",
  "INSTALLER_SRC_DIR",
  "INSTALLER_MANIFESTS_DIR",
  "INSTALLER_WORKFLOWS_DIR",
  "INSTALLER_PKG_DIR",
];

function artifactDirEnvConfig(env = process.env) {
  const out = {};
  for (const key of ARTIFACT_DIR_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

// ======================================================
// HUB APP FACTORY (testable; server.js starts it)
// ======================================================

function buildHubApp({ redis, config = {}, fetchImpl, intervals = true } = {}) {
  if (!redis) throw new Error('buildHubApp: redis is required');

  const {
    BACKEND_URL = "http://animastor-backend:3000",
    // 10 min — image ~1-2min, audio ~30s, video (LTX) ~5-10min.
    // ИНВАРИАНТ: GPU_TIMEOUT_MS должен быть МЕНЬШЕ STALL_FAILSAFE_MS backend'а
    // (backend/src/config/runtime-config.js, формула GPU_TIMEOUT_MS * 3).
    GPU_TIMEOUT_MS = 600000,
    GPU_HUB_API_KEY = null,
    // FAIL CLOSED (PW-4): an unset API key DENIES the backend-facing endpoints.
    // Explicit dev-only opt-out for local setups without a key.
    GPU_HUB_ALLOW_OPEN = null,
    // SH-1 kill-switch (worker sharing V1) — SYNC: backend/src/config/
    // runtime-config.js shareFeaturesEnabled(). DEFAULT OFF: disabling
    // returns the system bit-for-bit to pre-sharing behavior — no lane-
    // priority step-2 pop, no share_policy markers in heartbeats.
    SHARE_FEATURES_ENABLED = /^(1|true|on)$/i.test(String(process.env.SHARE_FEATURES_ENABLED || '')),
  } = config;

  const doFetch = fetchImpl || ((url, options) => fetch(url, options));

  /**
   * SH-1/SH-2: effective share policy for an AUTHENTICATED worker identity
   * (kill-switch + mode + policy checks combined). Null for share/system
   * modes (their lane IS the system pool already) and whenever the
   * kill-switch is OFF — the system stays bit-for-bit as before. A 'public'
   * policy borrows from the system pool; a 'users' policy borrows from its
   * own audience lane (never the system pool).
   * @returns {object|null} { policy_id, scope_kind, expires_at } | null
   */
  function effectiveSharePolicy(auth) {
    if (!SHARE_FEATURES_ENABLED) return null;   // kill-switch: today's behavior
    if (!auth || auth.mode !== 'private') return null;
    return activeSharePolicy(auth.share_policy);
  }

  /**
   * Heartbeat share_policy marker (D3): present ONLY while the kill-switch
   * is on and the policy is effective — heartbeats of workers without a
   * policy stay byte-identical to pre-sharing payloads (§7.4).
   */
  function sharePolicyMarker(auth) {
    const p = effectiveSharePolicy(auth);
    return p ? { policy_id: p.policy_id, scope_kind: p.scope_kind, expires_at: p.expires_at } : null;
  }

  /**
   * Claimer lane check for /task/result and /task/error (PW-4). The job's
   * workspace must match the claimer's lane:
   *   private lane job   → running workspace == claimer workspace (today);
   *   system-pool job    → workspace-less; finished normally by its claimer.
   * SH-1/SH-2: a private worker's BORROWED claim is identified by the
   * claim-time `worker_share_policy` snapshot in the running record — the
   * claim stays finishable even if the policy was stopped or expired mid-job
   * (§6: the claim is bound to the credential, not the policy). V1 borrowed
   * claims are public-pool (workspace-less) jobs; SH-2 users claims are
   * policy-lane (also workspace-less) jobs — both carry the snapshot, so a
   * single presence check covers them. When the snapshot is absent
   * (kill-switch off / no policy), this reduces EXACTLY to today's
   * comparison.
   */
  function taskLaneMatch(runningInfo, auth) {
    const jobWs = runningInfo.workspace_id || null;
    const claimerWs = auth.workspace_id || null;
    if (jobWs === claimerWs) return true;
    // Borrowed claim on a private worker (public borrow V1 or users-lane V2).
    return jobWs === null
      && (auth.mode || null) === 'private'
      && !!(runningInfo.worker_share_policy
            && runningInfo.worker_share_policy.policy_id);
  }

  const app = express()
  // v0.3.3: access log first, so every route (incl. 401/404) is counted
  const accessLog = createAccessLog(config.ACCESS_LOG ? { log: config.ACCESS_LOG } : {});
  app.use(accessLog.middleware);
  app.locals.flushAccessLog = accessLog.flush;
  if (intervals) {
    const t = setInterval(accessLog.flush, Number(config.ACCESS_SUMMARY_MS) > 0 ? Number(config.ACCESS_SUMMARY_MS) : ACCESS_SUMMARY_MS);
    if (t.unref) t.unref();
  }
  app.use(cors())
  // /v3/logs carries a gzip body and its own 128 KiB wire limit: its route
  // reads the raw stream itself (registered in the v3 section below), so the
  // global JSON parser must not consume it first.
  app.use(express.json({
    limit: "500mb",
    type: (req) => path.posix.normalize(req.path) !== '/v3/logs',
  }))

  // ======================================================
  // API KEY AUTH
  // ======================================================

  function requireApiKey(req, res, next) {
    // PW-4 FAIL CLOSED: no key configured → deny (the old "unset = open"
    // behavior left /task and /queue/clear exposed). GPU_HUB_ALLOW_OPEN=1
    // is the explicit dev-only opt-out.
    if (!GPU_HUB_API_KEY) {
      if (String(GPU_HUB_ALLOW_OPEN) === '1') return next();
      return res.status(503).json({ error: 'hub_api_key_not_configured' });
    }
    // T9: Header-only — не принимаем ключ в query string
    const provided = req.headers['x-api-key'];
    if (provided !== GPU_HUB_API_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  /** Headers for the hub→backend hop (key-authenticated when configured). */
  function backendHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (GPU_HUB_API_KEY) headers['x-api-key'] = GPU_HUB_API_KEY;
    return headers;
  }

  // ======================================================
  // GPU REGISTRY (Redis-backed, survives restart)
  // ======================================================

  const GPU_REGISTRY_KEY = 'animastor:gpu-hub:workers';

  async function getGpuFromRedis(id) {
    try {
      const raw = await redis.hget(GPU_REGISTRY_KEY, id);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function getAllGpusFromRedis() {
    try {
      const raw = await redis.hgetall(GPU_REGISTRY_KEY);
      if (!raw) return new Map();
      const result = new Map();
      for (const [id, json] of Object.entries(raw)) {
        result.set(id, JSON.parse(json));
      }
      return result;
    } catch { return new Map(); }
  }

  async function setGpuInRedis(id, data) {
    try {
      await redis.hset(GPU_REGISTRY_KEY, id, JSON.stringify(data));
      // TTL: prune stale registrations automatically
      await redis.expire(GPU_REGISTRY_KEY, 900); // 15 min
    } catch {}
  }

  async function deleteGpuFromRedis(id) {
    try { await redis.hdel(GPU_REGISTRY_KEY, id); } catch {}
  }

  // ======================================================
  // QUEUES
  // ======================================================
  // PW-2: workspace-scoped queue keys are derived from SERVER data only:
  //   enqueue — workspace_id authored by the backend in /task (key-gated);
  //   pop     — workspace_id from the authenticated token (never query/body).
  // The system pool keeps the legacy per-type keys.

  function queueKeyFor(type, workspaceId) {
    return workspaceId
      ? `animastor:queue:${type}:ws:${workspaceId}`
      : `animastor:queue:${type}`;
  }

  // SH-2 (V2): a users-scoped policy has its OWN audience lane — only the
  // granting worker ever pops it, and a revoked/expired policy simply stops
  // being popped (the backend drains the lane on stop; the dispatch-lease
  // re-dispatch is the backstop). Key is derived exclusively from the
  // credential-resolved policy (never from client input).
  function policyQueueKeyFor(type, policyId) {
    return `animastor:queue:${type}:policy:${policyId}`;
  }

  /** Discover all queue keys (system + workspace) via SCAN — never hardcode. */
  async function discoverQueueKeys() {
    const keys = new Set();
    for (const type of SYSTEM_JOB_TYPES) keys.add(`animastor:queue:${type}`);
    try {
      let cursor = '0';
      do {
        const scan = await redis.scan(cursor, 'MATCH', 'animastor:queue:*', 'COUNT', 500);
        cursor = scan[0];
        for (const key of scan[1] || []) keys.add(key);
      } while (cursor !== '0');
    } catch (_) {}
    return [...keys];
  }

  /** Dead-letter a poison/orphan-limit entry: kept for audit, never requeued. */
  async function deadLetter(rawEntry, reason) {
    try {
      await redis.lpush(DEAD_LETTER_KEY, JSON.stringify({
        reason: reason || 'unknown',
        ts: Date.now(),
        entry: rawEntry,
      }));
      await redis.expire(DEAD_LETTER_KEY, 7 * 24 * 3600).catch(() => {});
    } catch (_) {}
  }

  // ======================================================
  // ERROR DELIVERY → BACKEND
  // ======================================================
  // T3 консолидации: любая ошибка задачи (сбой воркера, worker_timeout)
  // доносится до backend → orchestrator.failStage. До этого backend узнавал
  // о падении только по истечении dispatch-lease (15–30 мин).
  // При недоставке — фолбэк-ключ animastor:error:{job_id} (симметрично
  // animastor:result:* для результатов), его подберёт recovery.

  function jobDedupKey(job_id, dispatch_id) {
    return `animastor:job:${dispatch_id}:${job_id}`;
  }

  // ======================================================
  // RESULT ACK (fallback key lifecycle)
  // ======================================================
  // /task/result stores animastor:result:* BEFORE the backend POST so a lost
  // delivery can be replayed by the backend reconciler. The hub is the only
  // writer of that key and the only party that sees the backend's answer, so
  // the hub removes it on ACK. Final = the backend settled this delivery:
  //   {ok:true}                 → processed (fenced commit / ready chain ran);
  //   {ok:true, rejected:true}  → terminal (identity/receipt/fence) — a
  //                               replay is rejected the same way.
  // NOT final → the key stays for reconcile:
  //   {ok:true, deduped:true}   → the backend dedup marker is dispatch-
  //                               independent; for a NEW generation of the
  //                               same job_id it can still belong to the
  //                               previous one. The reconciler compares the
  //                               dispatch recorded in the marker and drops
  //                               the key itself when it is a true duplicate.
  //   unreadable body / non-2xx → unknown outcome.
  const RESULT_ACK_DELETE_SCRIPT =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

  async function readAckBody(res) {
    try {
      if (res && typeof res.json === 'function') return await res.json();
    } catch (_) {}
    return null;
  }

  function resultAckIsFinal(body) {
    return !!(body && body.ok === true && body.deduped !== true);
  }

  async function ackDeleteResultKey(key, expectedValue) {
    try {
      return Number(await redis.eval(RESULT_ACK_DELETE_SCRIPT, 1, key, expectedValue)) || 0;
    } catch (err) {
      // Best-effort: a kept key is replayed by reconcile and deduplicated there.
      console.warn(`⚠️ result ACK delete failed for ${key}: ${err.message}`);
      return 0;
    }
  }

  // GPU retry policy (2026-11-02): optional structured error fields from
  // workers 2.2.3+ — forwarded as-is after a shape check (the backend
  // classifies; unknown/invalid values are dropped, never invented here).
  const ERROR_CLASSES = new Set(["deterministic", "transient", "oom"])
  function errorClassFields(body) {
    const out = {}
    const cls = body && typeof body.error_class === "string" ? body.error_class.trim().toLowerCase() : ""
    if (ERROR_CLASSES.has(cls)) out.error_class = cls
    const st = body ? Number(body.comfy_status) : NaN
    if (Number.isInteger(st) && st >= 100 && st <= 599) out.comfy_status = st
    return out
  }

  async function notifyBackendError(job_id, build_id, dispatch_id, reason, ownership = {}, errorFields = {}) {
    for (let i = 0; i < 5; i++) {
      try {
        const backendRes = await doFetch(
          `${BACKEND_URL}/gpu/task/error`,
          {
            method: "POST",
            headers: backendHeaders(),
            body: JSON.stringify({
              job_id,
              build_id: build_id || null,
              dispatch_id,
              protocol_version: PROTOCOL_VERSION,
              reason: reason || "unknown",
              // PW-2: audit-only forwarding — the backend re-verifies
              // job→book→workspace itself and never trusts these fields.
              worker_id: ownership.worker_id || null,
              workspace_id: ownership.workspace_id || null,
              ...errorFields
            })
          }
        )
        if (!backendRes.ok) throw new Error(`HTTP ${backendRes.status}`)
        return true
      } catch (err) {
        console.error(`⚠️ backend error-delivery retry ${i + 1} failed`, job_id, err.message)
        await new Promise(r => setTimeout(r, 500))
      }
    }
    console.error("❌ backend error-delivery failed:", job_id)
    try {
      await redis.set(
        `animastor:error:${job_id}`,
        JSON.stringify({
          job_id,
          build_id: build_id || null,
          dispatch_id,
          protocol_version: PROTOCOL_VERSION,
          reason: reason || "unknown",
          ...errorFields,
          ts: Date.now()
        }),
        "EX",
        3600
      )
    } catch (_) {}
    return false
  }

  // ======================================================
  // STALE DISPATCH (409) — explicit detail + backend signal
  // ======================================================
  // v0.2.9 (reports/2026-11-04/regenerate-sweep-fix.md): /task/result and
  // /task/error answer 409 stale_or_unknown_dispatch with a `detail`:
  //   no_running_record — the claim of this job is gone from
  //                       animastor:running (a queue cleanup removed it, or
  //                       the orphan sweep / timeout finalised it);
  //   dispatch_mismatch — the job is running under ANOTHER dispatch (it was
  //                       re-dispatched; the current dispatch is alive).
  // The result itself is NOT accepted: without the running record the hub
  // cannot prove the submitter is the claimer (PW-4 fail closed). For
  // no_running_record the backend is told ONCE per dispatch×job through the
  // regular error path (POST /gpu/task/error, fallback animastor:error:*),
  // reason `stale_dispatch_result`, error_class `transient`: the backend
  // verifies the dispatch identity itself — a cancelled/superseded dispatch
  // is rejected there, a live one is failed and retried by the GPU retry
  // policy (command-gated). dispatch_mismatch is never signalled.
  const STALE_SIGNAL_PREFIX = 'animastor:stale-dispatch-signal'
  const STALE_SIGNAL_TTL_S = 3600

  function staleDispatchDetail(runningInfo) {
    return runningInfo ? 'dispatch_mismatch' : 'no_running_record'
  }

  async function signalStaleDispatch(job_id, build_id, dispatch_id, auth, source) {
    try {
      const first = await redis.set(`${STALE_SIGNAL_PREFIX}:${dispatch_id}:${job_id}`, String(Date.now()), 'EX', STALE_SIGNAL_TTL_S, 'NX')
      if (!first) return false
    } catch (_) { return false }
    console.warn(`📣 stale dispatch signalled to backend: ${job_id} dispatch=${dispatch_id} source=${source}`)
    return notifyBackendError(job_id, build_id, dispatch_id, 'stale_dispatch_result', {
      worker_id: auth && auth.worker_id || null,
      workspace_id: auth && auth.workspace_id || null
    }, { error_class: 'transient', hub_detail: 'no_running_record', source })
  }

  function rejectStaleDispatch(res, kind, { job_id, build_id, dispatch_id, runningInfo, auth, workerReason }) {
    const detail = staleDispatchDetail(runningInfo)
    console.warn(`⚠️ ${kind} rejected 409 (${detail}): ${job_id} dispatch=${dispatch_id} worker=${auth && auth.worker_id || 'unknown'}${workerReason ? ` reason=${String(workerReason).slice(0, 200)}` : ''}`)
    if (detail === 'no_running_record') {
      // Fire-and-forget: the worker gets its 409 at once; delivery retries
      // (and the animastor:error:* fallback) run in the background.
      signalStaleDispatch(job_id, build_id, dispatch_id, auth, kind === 'Result' ? 'task_result' : 'task_error').catch(() => {})
    }
    return res.status(409).json({ error: "stale_or_unknown_dispatch", detail, job_id, dispatch_id })
  }

  // ======================================================
  // HEARTBEAT REFRESH + GPU TIMEOUT + ORPHAN SWEEP (10s)
  // ======================================================
  // Responsibilities of the interval:
  // 1. Refresh heartbeat for running tasks so busyImage stays valid
  // 2. Clean up timed-out GPUs and report their tasks as failed to backend
  //    (T3: hub — тупой транспорт; retry-решение принимает backend-планировщик)
  // 3. PW-2: sweep `animastor:processing` for orphaned claims (crash between
  //    rpoplpush and the running-record write) and requeue them.

  async function heartbeatAndTimeoutSweep() {
    const now = Date.now()

    // ── Refresh heartbeat for all running tasks ──
    try {
      const running = await redis.hgetall("animastor:running")
      for (const job_id in running) {
        try {
          const data = JSON.parse(running[job_id])
          if (data.worker && data.job_type) {
            const hbKey = `animastor:worker:heartbeat:${data.job_type}:${data.worker}`
            const hbPayload = {
              type: data.job_type,
              worker_id: data.worker,
              ts: Date.now(),
              current_job_id: job_id,
              current_dispatch_id: data.dispatch_id || null,
              // VISIBILITY: scope fields — the backend counts a heartbeat as
              // globally available ONLY when it carries no workspace (system
              // pool). A private worker's heartbeat stays workspace-scoped.
              // SH-1: ONLY a borrowed (system-pool) claim on a private worker
              // re-stamps the WORKER's own workspace so the owner's counts
              // stay correct; every other case keeps today's task-scoped
              // value byte-for-byte.
              workspace_id: (data.worker_mode === 'private'
                  && data.workspace_id == null
                  && data.worker_workspace_id != null)
                ? data.worker_workspace_id
                : (data.workspace_id || null),
              mode: data.worker_mode || null,
              version: data.worker_version || null,
              image_tag: data.worker_image_tag || null,
              protocol_version: data.worker_protocol_version || null
            }
            // SH-1/SH-2 (D3): re-stamp the optional share_policy marker from
            // the claim-time snapshot. Expiry re-checked on read here too —
            // a policy that expires mid-job stops feeding the global count
            // even while its last job is still running. Absent snapshot →
            // payload byte-identical to today. (A 'users' marker rides along
            // too; worker-health only counts PUBLIC markers as global
            // capacity — a users-shared worker never serves the public pool.)
            const sp = data.worker_share_policy;
            if (sp && activeSharePolicy(sp)) {
              hbPayload.share_policy = { policy_id: sp.policy_id, scope_kind: sp.scope_kind, expires_at: sp.expires_at };
            }
            await redis.set(hbKey, JSON.stringify(hbPayload), 'EX', 30)
          }
        } catch (_) {}
      }
    } catch (_) {}

    // ── GPU timeout cleanup (Redis-backed) ──
    const allGpus = await getAllGpusFromRedis();
    const running = await redis.hgetall("animastor:running")
    const runningMap = new Map(Object.entries(running || {}).map(([k, v]) => [k, JSON.parse(v)]));

    // ── Level 1: Per-job timeout ──
    for (const [job_id, data] of runningMap) {
      const jobTimeoutMs = data.timeout_ms || GPU_TIMEOUT_MS;
      const jobStarted = data.started_at || 0;
      if (now - jobStarted > jobTimeoutMs) {
        console.log(`💀 Job timeout: ${job_id} (type=${data.job_type}, timeout=${Math.round(jobTimeoutMs / 1000)}s, started=${Math.round((now - jobStarted) / 1000)}s ago)`)
        try {
          await redis.hdel("animastor:running", job_id)
          if (data.task_raw) {
            await redis.lrem("animastor:processing", 1, data.task_raw).catch(() => {})
          }
          await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
          if (data.dispatch_id) {
            await redis.del(jobDedupKey(job_id, data.dispatch_id)).catch(() => {})
          }
          await notifyBackendError(job_id, data.build_id, data.dispatch_id, "worker_timeout", {
            worker_id: data.worker || null,
            workspace_id: data.workspace_id || null
          })
        } catch (err) {
          console.error("Job timeout error:", err)
        }
      }
    }

    // ── Level 2: Per-GPU timeout (for jobs still running on stale GPUs) ──
    for (const [id, gpu] of allGpus) {

      if (now - gpu.last_seen > GPU_TIMEOUT_MS) {

        // Distinguish an idle worker that simply went offline (normal after a
        // run) from a worker that died WHILE holding jobs. The old code logged
        // the same scary 💀 line for both; an idle shutdown is not an incident.
        const gpuJobs = [];
        for (const [job_id, data] of runningMap) {
          if (data.worker !== id) continue;
          // Skip if already handled by per-job timeout
          const jobTimeoutMs = data.timeout_ms || GPU_TIMEOUT_MS;
          const jobStarted = data.started_at || 0;
          if (now - jobStarted > jobTimeoutMs) continue;
          gpuJobs.push([job_id, data]);
        }

        if (gpuJobs.length === 0) {
          console.log(`[GPU] worker offline: ${id} (no running jobs, last heartbeat ${Math.round((now - gpu.last_seen) / 1000)}s ago)`)
        } else {
          console.log(`💀 GPU timeout: ${id} (running jobs: ${gpuJobs.length})`)
        }

        for (const [job_id, data] of gpuJobs) {
          console.log("💀 Worker timeout, reporting failure:", job_id)

          await redis.hdel("animastor:running", job_id)
          if (data.task_raw) {
            await redis.lrem("animastor:processing", 1, data.task_raw).catch(() => {})
          }
          await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})

          // Освобождаем dedup очереди, чтобы re-dispatch backend'а не
          // отбился как duplicate.
          if (data.dispatch_id) {
            await redis.del(jobDedupKey(job_id, data.dispatch_id)).catch(() => {})
          }

          await notifyBackendError(job_id, data.build_id, data.dispatch_id, "worker_timeout", {
            worker_id: data.worker || null,
            workspace_id: data.workspace_id || null
          })
        }

        await deleteGpuFromRedis(id);
      }
    }
  }

  /**
   * PW-2 processing orphan sweep. An entry in `animastor:processing` with no
   * `animastor:running` record is a crashed claim (hub died between rpoplpush
   * and the running write — no recovery reader existed before). After a grace
   * period the task is requeued to ITS OWN queue (workspace-scoped or system);
   * after MAX_ORPHAN_REQUEUES it is dead-lettered and reported to the backend.
   * Poison entries (unparseable / no job_id) are dead-lettered, never requeued.
   */
  async function sweepProcessingOrphans(now = Date.now()) {
    let items = [];
    try {
      items = await redis.lrange("animastor:processing", 0, -1) || [];
    } catch (_) { return; }

    for (const raw of items) {
      let task = null;
      try { task = JSON.parse(raw); } catch (_) { task = null; }
      if (!task || !task.job_id) {
        await redis.lrem("animastor:processing", 1, raw).catch(() => {});
        await deadLetter(raw, 'poison_processing_entry');
        continue;
      }
      const jobId = task.job_id;

      let runningRaw = null;
      try { runningRaw = await redis.hget("animastor:running", jobId); } catch (_) {}
      if (runningRaw) {
        // Actively claimed — drop any stale orphan bookkeeping.
        await redis.hdel(PROCESSING_CLAIMED_KEY, jobId).catch(() => {});
        continue;
      }

      let seen = null;
      try {
        const seenRaw = await redis.hget(PROCESSING_CLAIMED_KEY, jobId);
        seen = seenRaw ? JSON.parse(seenRaw) : null;
      } catch (_) { seen = null; }

      if (!seen) {
        // First sighting — start the grace window, do not act yet.
        await redis.hset(PROCESSING_CLAIMED_KEY, jobId, JSON.stringify({ first_seen: now })).catch(() => {});
        continue;
      }
      if (now - (seen.first_seen || now) < ORPHAN_GRACE_MS) continue;

      // Confirmed orphan — pull it out of processing first.
      await redis.lrem("animastor:processing", 1, raw).catch(() => {});
      await redis.hdel(PROCESSING_CLAIMED_KEY, jobId).catch(() => {});

      const requeues = Number(task.orphan_requeues || 0);
      if (requeues >= MAX_ORPHAN_REQUEUES) {
        console.error(`☠️ Orphan requeue limit reached: ${jobId} (${requeues} requeues) — dead-lettered`);
        await deadLetter(raw, 'orphan_requeue_limit');
        await notifyBackendError(jobId, task.build_id, task.dispatch_id, "orphaned_task", {
          workspace_id: task.workspace_id || null
        });
        continue;
      }

      // Requeue to the task's OWN queue — workspace-scoped, system pool, or
      // (SH-2) the users-policy lane the backend routed it into (the
      // policy_id stamp survives the crash; a dead policy's lane is drained
      // by the backend and backstopped by the dispatch-lease re-dispatch).
      const queueKey = task.policy_id
        ? policyQueueKeyFor(task.job_type || 'image', task.policy_id)
        : queueKeyFor(task.job_type || 'image', task.workspace_id || null);
      task.orphan_requeues = requeues + 1;
      try {
        await redis.lpush(queueKey, JSON.stringify(task));
        console.log(`♻️ Orphan requeued: ${jobId} → ${queueKey} (attempt ${task.orphan_requeues})`);
      } catch (err) {
        console.error(`Orphan requeue failed: ${jobId}`, err.message);
        await deadLetter(raw, 'orphan_requeue_failed');
      }
    }
  }

  let intervalTimer = null;
  if (intervals) {
    intervalTimer = setInterval(() => {
      heartbeatAndTimeoutSweep().catch(err => console.error('Hub sweep error:', err.message));
      sweepProcessingOrphans().catch(err => console.error('Orphan sweep error:', err.message));
    }, 10000);
    if (intervalTimer.unref) intervalTimer.unref();
  }

  // ======================================================
  // BEACON
  // ======================================================
  // PW-4 FAIL CLOSED: identity comes ONLY from a valid Bearer credential —
  // there is no uncredentialed lane. A missing/invalid credential never
  // becomes SYSTEM or SHARE; it is simply rejected (401).

  const HEARTBEAT_TTL_SECONDS = 30;
  // The protocol-3 relay tags its own heartbeat records with this value
  // (see /v3/beacon). A v2 tick must not overwrite what it owns.
  const HEARTBEAT_V3_TAG = 3;

  function heartbeatKey(type, id) {
    return `animastor:worker:heartbeat:${type}:${id}`;
  }

  /**
   * The v3-owned record in a heartbeat key, if it is still fresh.
   * /beacon (v2) and /v3/beacon write the SAME key, both every 10 s, so a
   * blind SET from either side erases the other's fields. The v3 record
   * owns protocol_version + current_job_id (reports/2026-11-06 §10); it is
   * "fresh" while it is younger than the key's own 30 s TTL.
   */
  async function readFreshV3Heartbeat(key) {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || rec.protocol_version !== HEARTBEAT_V3_TAG) return null;
      const ts = Number(rec.ts);
      if (!Number.isFinite(ts) || Date.now() - ts >= HEARTBEAT_TTL_SECONDS * 1000) return null;
      return rec;
    } catch (_) { return null; }
  }

  app.post("/beacon", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

    const { gpu, vram, version, image_tag, protocol_version } = req.body
    // Registry identity is server-derived; body id/type are labels only.
    const workerId = auth.worker_id;
    const workerType = auth.worker_type;

    if (!workerId || !workerType) {
      return res.status(400).json({ error: "worker_identity_required" })
    }
    if (protocol_version !== PROTOCOL_VERSION) {
      return res.status(409).json({
        error: "protocol_version_mismatch",
        expected: PROTOCOL_VERSION,
        received: protocol_version || null
      })
    }

    const data = {
      id: workerId,
      type: workerType,
      gpu,
      vram,
      version: version || null,
      image_tag: image_tag || null,
      protocol_version: protocol_version || null,
      workspace_id: auth.workspace_id || null,
      last_seen: Date.now()
    };

    // Primary registry: Redis (survives restart, cluster-aware)
    await setGpuInRedis(workerId, data);

    // Also write heartbeat for backend worker count panel.
    // VISIBILITY: the payload carries the registry-derived scope
    // (workspace_id + mode ∈ private|share|system) so the backend separates
    // SYSTEM/SHARE capacity from a workspace's PRIVATE workers.
    // SH-1 (D3): a policy-active private worker additionally carries the
    // optional share_policy marker — the backend counts it in BOTH the
    // owner's private_* bucket and the global pool. Without an active
    // policy (or with the kill-switch off) the payload is byte-identical
    // to the pre-sharing shape.
    try {
      const key = heartbeatKey(workerType, workerId);
      const payload = {
        type: workerType,
        worker_id: workerId,
        ts: Date.now(),
        workspace_id: auth.workspace_id || null,
        mode: auth.mode || null,
        version: version || null,
        image_tag: image_tag || null,
        protocol_version: protocol_version || null
      };
      const marker = sharePolicyMarker(auth);
      if (marker) payload.share_policy = marker;
      // A worker on the protocol-3 relay also ticks /v3/beacon against this
      // key. Merge its fields instead of SETting the v2 payload over them:
      // protocol_version 3 and the running v3 job survive the v2 tick, so
      // the legacy busy count sees it. A v2-only worker sees the old shape.
      const v3 = await readFreshV3Heartbeat(key);
      if (v3) {
        payload.protocol_version = v3.protocol_version;
        payload.current_job_id = v3.current_job_id ?? null;
      }
      await redis.set(key, JSON.stringify(payload), 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (_) {}

    res.json({ ok: true })
  })

  // ======================================================
  // TASK CREATE
  // ======================================================

  app.post("/task", requireApiKey, async (req, res) => {

    const {
      job_id,
      params,
      job_type,
      assets,
      build_id,
      protocol_version,
      dispatch_id,
      book_id,
      chapter_id,
      scene_id,
      stage,
      workspace_id,
      timeout_ms,
      policy_id
    } = req.body

    const type = job_type || "image"

    console.log("📥 Task:", job_id, type, "build:", build_id, "timeout_ms:", timeout_ms || "(default)", "workspace:", workspace_id || "(system pool)", policy_id ? `policy:${policy_id}` : "")

    // Job Protocol v2 — PROTOCOL_VERSION is imported from @animastor/contracts
    // (canonical source; no local literal — Phase 10B).
    if (protocol_version !== PROTOCOL_VERSION) {
      return res.status(409).json({
        error: "protocol_version_mismatch",
        expected: PROTOCOL_VERSION,
        received: protocol_version || null
      })
    }
    if (!dispatch_id || !build_id || !book_id || !chapter_id || !scene_id || !stage) {
      return res.status(400).json({ error: "incomplete_dispatch_identity" })
    }
    // PW-2: workspace_id is backend-authored (book → workspace). The hub
    // validates shape only — a malformed value is rejected, never trusted.
    if (workspace_id !== undefined && workspace_id !== null) {
      if (typeof workspace_id !== 'string' || !WORKSPACE_ID_RE.test(workspace_id)) {
        return res.status(400).json({ error: "invalid_workspace_id" })
      }
    }
    // SH-2 (V2): policy_id is the backend-authored users-policy lane stamp.
    // Shape-validated UUID; must never coexist with workspace_id (a job is
    // either the owner's ws-lane job or a policy-lane job, never both — the
    // backend dispatcher enforces the same rule at send time).
    if (policy_id !== undefined && policy_id !== null) {
      if (typeof policy_id !== 'string' || !WORKSPACE_ID_RE.test(policy_id)) {
        return res.status(400).json({ error: "invalid_policy_id" })
      }
      if (workspace_id) {
        return res.status(400).json({ error: "invalid_policy_routing" })
      }
    }

    if (assets?.image) {
      console.log(
        "🖼 asset image size:",
        Math.round(assets.image.length / 1024),
        "KB"
      )
    }
    // BEST-EFFORT dedup: защищает только очередь hub'а от двойного enqueue.
    // Авторитетный dedup результатов — на backend
    // (animastor:result-processed:{job_id}:{build_id}, generation-routes).
    // Этот ключ НЕ гарантия и не должен блокировать легитимный retry —
    // backend чистит его перед принудительным re-dispatch.
    const isNew = await redis.set(
      jobDedupKey(job_id, dispatch_id),
      1,
      "NX",
      "EX",
      3600
    )

    if (!isNew) {
      console.log("⚠️ Duplicate job ignored:", job_id)
      return res.json({ ok: true, duplicate: true })
    }

    await redis.lpush(
      policy_id ? policyQueueKeyFor(type, policy_id) : queueKeyFor(type, workspace_id || null),
      JSON.stringify({
        job_id,
        params,
        job_type: type,
        assets: assets || null,
        build_id: build_id || null,
        protocol_version,
        // T9: Structured ownership для точной фильтрации без prefix-коллизий
        book_id,
        chapter_id,
        scene_id,
        stage,
        dispatch_id,
        // PW-2: server-derived ownership anchor (backend-authored; null =
        // system pool job — never set from any worker-facing input).
        workspace_id: workspace_id || null,
        // SH-2: the backend-authored policy-lane stamp (users sharing V2).
        // Null on every ws-lane and plain system-pool task — present ONLY on
        // tasks the backend routed into queue:{type}:policy:{id} (drained
        // tasks are re-pushed with the marker stripped, so this field always
        // means "belongs to a policy lane").
        policy_id: policy_id || null,
        // Per-job timeout, переданный backend'ом (layer-config per-type timeout).
        // Без проброса per-job timeout падал бы на GPU_TIMEOUT_MS (10 мин по
        // умолчанию) — нормальная долгая видео-генерация (20-60+ мин) убивалась
        // как worker_timeout. ИНВАРИАНТ: per-job timeout >= GPU_TIMEOUT_MS —
        // ниже базового порога не опускаемся никогда.
        timeout_ms: timeout_ms && Number(timeout_ms) > 0
          ? Math.max(Number(timeout_ms), GPU_TIMEOUT_MS)
          : null
      })
    )

    res.json({ ok: true })
  })

  // ======================================================
  // TASK NEXT
  // ======================================================
  // PW-4 FAIL CLOSED: identity comes ONLY from the Bearer credential.
  //   private → pops ONLY its own workspace+type queue;
  //   share   → pops the community/system pool (workspace-less jobs);
  //   system  → pops the Animastor-operated pool (workspace-less jobs).
  // No credential → 401. The `worker`/`type` query params are never
  // identity — they are validated against the registry record.

  app.get("/task/next", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

    const { type } = req.query

    // Identity is token-derived.
    const workerId = auth.worker_id;
    const workerType = auth.worker_type;

    if (!workerId) {
      return res.status(400).json({ error: "worker required" })
    }
    if (type && auth.worker_type !== type) {
      // A worker may only ever pop its registered type.
      return res.status(409).json({
        error: "worker_type_mismatch",
        registered: auth.worker_type,
        requested: type
      })
    }

    const gpu = await getGpuFromRedis(workerId);
    if (!gpu) {
      return res.status(404).json({ error: "not registered" })
    }
    if (gpu.protocol_version !== PROTOCOL_VERSION) {
      return res.status(409).json({
        error: "worker_protocol_mismatch",
        expected: PROTOCOL_VERSION,
        received: gpu.protocol_version || null
      })
    }
    if (workerType && gpu.type !== workerType) {
      return res.status(409).json({
        error: "worker_type_mismatch",
        registered: gpu.type,
        requested: workerType
      })
    }

    gpu.last_seen = Date.now();
    await setGpuInRedis(workerId, gpu);

    // PW-4: mode-scoped pop. Private worker → its workspace queue ONLY;
    // share/system → the system pool ONLY. Cross-workspace and private-pool
    // access are structurally impossible (the key is never derivable from
    // the client).
    //
    // SH-1 (worker sharing V1, §6.1 lane priority — kill-switch gated):
    //   1. pop queue:{type}:ws:{workspace_id}   (owner's lane — STRICT priority)
    //   2. if empty → spare capacity lane of the active policy:
    //        public → queue:{type}               (the shared system pool)
    //        users  → queue:{type}:policy:{id}   (SH-2: the granted audience)
    // Step 2 exists only when the kill-switch is ON and the worker carries
    // an effective (expiry-rechecked) share policy. A USERS policy never
    // touches the system pool — its spare capacity serves ONLY its granted
    // audience (no public leak). No per-policy cleanup on revoke: the
    // backend drains the lane (stop path) and the claim is bound to the
    // credential, not the policy (§6).
    const policy = effectiveSharePolicy(auth);
    const popWorkspaceId = auth.mode === 'private' ? auth.workspace_id : null;
    const queueKey = queueKeyFor(workerType, popWorkspaceId)

    let taskRaw = await redis.rpoplpush(
      queueKey,
      "animastor:processing"
    )
    // Lane bookkeeping for the poison cross-check below:
    //   'ws'     — the popper's own workspace lane (owner jobs);
    //   'system' — the public pool (share/system primary, public-policy spare);
    //   'policy' — SH-2 users-policy audience lane (workspace-less jobs
    //              stamped with the policy id by the backend dispatcher).
    let lane = popWorkspaceId != null ? 'ws' : 'system';

    if (!taskRaw && lane === 'ws' && policy) {
      // Step 2: spare capacity — borrow only after the owner's lane drains.
      const borrowQueue = policy.scope_kind === 'users'
        ? policyQueueKeyFor(workerType, policy.policy_id)
        : queueKeyFor(workerType, null)
      taskRaw = await redis.rpoplpush(
        borrowQueue,
        "animastor:processing"
      )
      if (taskRaw) lane = policy.scope_kind === 'users' ? 'policy' : 'system';
    }

    if (!taskRaw) return res.json({ task: null })

    const task = JSON.parse(taskRaw)

    // PW-2 poison-write cross-check: a popped item must match the lane it
    // came from. ws lane → the owner's workspace stamp; system pool →
    // workspace-less, unstamped jobs; SH-2 policy lane → workspace-less
    // jobs stamped with EXACTLY this worker's active policy id (a foreign
    // policy's task in this lane is a poison write — dead-letter, never
    // hand it out).
    const taskWs = task.workspace_id || null;
    let laneOk;
    if (lane === 'ws') {
      laneOk = taskWs === auth.workspace_id;
    } else if (lane === 'system') {
      laneOk = taskWs === null && !task.policy_id;
    } else {
      laneOk = taskWs === null && task.policy_id === policy.policy_id;
    }
    if (!laneOk) {
      console.error(`🧪 Poison write detected on ${lane} lane: job=${task.job_id} task_ws=${taskWs || 'null'} task_policy=${task.policy_id || 'null'} lane_policy=${lane === 'policy' ? policy.policy_id : 'null'}`);
      await redis.lrem("animastor:processing", 1, taskRaw).catch(() => {});
      await deadLetter(taskRaw, lane === 'policy' ? 'poison_policy_mismatch' : 'poison_workspace_mismatch');
      return res.json({ task: null })
    }

    await redis.hset(
      "animastor:running",
      task.job_id,
      JSON.stringify({
        worker: workerId,
        // PW-2: claim binds the job to the authenticated worker + workspace.
        workspace_id: task.workspace_id || null,
        // VISIBILITY: kept so heartbeat refreshes (sweep/result/error) can
        // re-stamp the scope without re-authenticating.
        worker_mode: auth.mode || null,
        // SH-1: the WORKER's own workspace scope for heartbeat re-stamps —
        // a borrowed (system-pool) claim on a private worker keeps the
        // OWNER's scope in heartbeats so the owner's counts stay correct.
        worker_workspace_id: auth.workspace_id || null,
        // SH-1: claim-time snapshot of the active policy (null unless the
        // kill-switch was on and a public policy was effective). Kept in the
        // running record so a running claim finishes normally even if the
        // policy is stopped mid-job — "the claim is bound to the credential,
        // not the policy" (§6).
        worker_share_policy: policy
          ? { policy_id: policy.policy_id, scope_kind: policy.scope_kind, expires_at: policy.expires_at }
          : null,
        job_type: task.job_type,
        params: task.params,
        assets: task.assets || null,
        build_id: task.build_id || null,
        book_id: task.book_id,
        chapter_id: task.chapter_id,
        scene_id: task.scene_id,
        stage: task.stage,
        dispatch_id: task.dispatch_id,
        timeout_ms: task.timeout_ms || null,
        protocol_version: task.protocol_version,
        worker_version: gpu.version || null,
        worker_image_tag: gpu.image_tag || null,
        worker_protocol_version: gpu.protocol_version || null,
        task_raw: taskRaw,
        started_at: Date.now()
      })
    )

    console.log(`🚀 ${task.job_id} → ${workerId} (${task.job_type}) build:${task.build_id || "none"} timeout_ms:${task.timeout_ms || "(default)"} mode:${auth.mode}${policy ? "+shared" : ""} ws:${task.workspace_id || "(system pool)"}`)

    // Mark worker as busy in heartbeat (scope fields per VISIBILITY note).
    try {
      const hbKey = `animastor:worker:heartbeat:${task.job_type}:${workerId}`;
      const hbPayload = {
        type: task.job_type,
        worker_id: workerId,
        ts: Date.now(),
        current_job_id: task.job_id,
        current_dispatch_id: task.dispatch_id,
        workspace_id: auth.workspace_id || null,
        mode: auth.mode || null,
        version: gpu.version || null,
        image_tag: gpu.image_tag || null,
        protocol_version: gpu.protocol_version || null
      };
      const marker = sharePolicyMarker(auth);
      if (marker) hbPayload.share_policy = marker;
      await redis.set(hbKey, JSON.stringify(hbPayload), 'EX', 30);
    } catch (_) {}

    res.json({ task })
  })

  // ======================================================
  // RESULT (WITH RETRY)
  // ======================================================
  // PW-4 FAIL CLOSED: claimer-only, credential required. The submitter must
  // be the worker that claimed the job (worker + workspace match the running
  // record). A worker can never complete another worker's job or another
  // workspace's job; share/system workers complete workspace-less jobs only.

  app.post("/task/result", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

    const { job_id, build_id, result_base64, dispatch_id, protocol_version } = req.body

    if (!job_id || !build_id || !result_base64 || !dispatch_id || protocol_version !== PROTOCOL_VERSION) {
      return res.status(400).json({ error: "invalid" })
    }

    console.log("📤 Result:", job_id, "build:", build_id || "none", "size:", Math.round((result_base64 || "").length / 1024), "KB")

    // Read running info to get worker/job_type before deleting
    let runningInfo = null;
    try {
      const raw = await redis.hget("animastor:running", job_id);
      if (raw) {
        runningInfo = JSON.parse(raw);
      }
    } catch (_) {}
    if (!runningInfo || runningInfo.dispatch_id !== dispatch_id) {
      return rejectStaleDispatch(res, 'Result', { job_id, build_id, dispatch_id, runningInfo, auth })
    }

    // PW-4 claimer check: the submitter must BE the claimer and the job's
    // workspace must match the claimer's lane (private → its workspace;
    // share/system → workspace-less jobs only).
    // SH-1: a policy-active private worker's BORROWED claim (system-pool
    // job: workspace-less + claim-time policy snapshot in the running
    // record) finishes normally — the claim is bound to the credential, not
    // the policy (§6). The snapshot can only exist when the pop gate allowed
    // the borrow, and it survives mid-job stop/expiry by design.
    if (runningInfo.worker !== auth.worker_id ||
        !taskLaneMatch(runningInfo, auth)) {
      console.error(`🚫 Result rejected (not claimer): job=${job_id} submitter=${auth.worker_id} claimer=${runningInfo.worker} ws=${auth.workspace_id || 'null'} vs ${runningInfo.workspace_id || 'null'}`);
      return res.status(403).json({ error: "not_task_claimer" })
    }

    // Store result as JSON so audio-recovery can parse it.
    // key format: animastor:result:<build_id>:<book_id>:<chapter_id>:<scene_id>:<type>
    // job_id format: "bookId_chapterId_sceneId_chunkIndex:type"
    // bookId can contain underscores, but chapterId/sceneId/chunkIndex cannot.
    // Split by ':' first to remove type suffix, then parse from the end.
    // SYNC: backend/src/runtime/job-schema.js — упрощённая копия parseJobId;
    // при изменении формата job_id обновить оба места.
    const resultType = runningInfo.stage;
    const resultBookId = runningInfo.book_id;
    const resultChapterId = runningInfo.chapter_id;
    const resultSceneId = runningInfo.scene_id;
    const resultData = JSON.stringify({
      job_id,
      result_base64,
      build_id,
      dispatch_id,
      protocol_version
    });
    const resultRedisKey = `animastor:result:${build_id}:${resultBookId}:${resultChapterId}:${resultSceneId}:${resultType}`;
    await redis.set(
      resultRedisKey,
      resultData,
      "EX",
      3600 // 1 hour
    )

    await redis.hdel("animastor:running", job_id)
    await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
    if (runningInfo.task_raw) {
      await redis.lrem("animastor:processing", 1, runningInfo.task_raw).catch(() => {})
    }

    // Clear busy flag from worker heartbeat (scope fields per VISIBILITY note).
    // SH-1: keep the WORKER's own scope for borrowed claims and re-stamp the
    // policy marker (expiry re-checked) — see the sweep refresh note.
    if (runningInfo.worker && runningInfo.job_type) {
      try {
        const hbKey = `animastor:worker:heartbeat:${runningInfo.job_type}:${runningInfo.worker}`;
        const hbPayload = {
          type: runningInfo.job_type,
          worker_id: runningInfo.worker,
          ts: Date.now(),
          current_job_id: null,
          current_dispatch_id: null,
          workspace_id: (runningInfo.worker_mode === 'private'
              && runningInfo.workspace_id == null
              && runningInfo.worker_workspace_id != null)
            ? runningInfo.worker_workspace_id
            : (runningInfo.workspace_id || null),
          mode: runningInfo.worker_mode || null,
          version: runningInfo.worker_version || null,
          image_tag: runningInfo.worker_image_tag || null,
          protocol_version: runningInfo.worker_protocol_version || null
        };
        const sp = runningInfo.worker_share_policy;
        if (sp && activeSharePolicy(sp)) {
          hbPayload.share_policy = { policy_id: sp.policy_id, scope_kind: sp.scope_kind, expires_at: sp.expires_at };
        }
        await redis.set(hbKey, JSON.stringify(hbPayload), 'EX', 30);
      } catch (_) {}
    }

    let success = false
    let ackBody = null

    for (let i = 0; i < 5; i++) {
      try {
        const backendRes = await doFetch(
          `${BACKEND_URL}/gpu/task/result`,
          {
            method: "POST",
            headers: backendHeaders(),
            body: JSON.stringify({
              job_id,
              build_id,
              dispatch_id,
              protocol_version,
              result_base64,
              // PW-2: audit-only forwarding — backend re-verifies
              // job→book→workspace itself and never trusts these fields.
              worker_id: runningInfo.worker || null,
              workspace_id: runningInfo.workspace_id || null
            })
          }
        )

        if (!backendRes.ok) {
          throw new Error(`HTTP ${backendRes.status}`)
        }

        success = true
        ackBody = await readAckBody(backendRes)
        break
      } catch (err) {
        console.error(`⚠️ backend retry ${i + 1} failed`, job_id, err.message)
        await new Promise(r => setTimeout(r, 500))
      }
    }

    if (!success) {
      console.error("❌ backend delivery failed:", job_id)
    } else if (resultAckIsFinal(ackBody)) {
      // ACK: the backend settled THIS delivery (processed or terminally
      // rejected) — the fallback copy has done its job. Compare-and-delete:
      // the key is per scene×type, so the next IU of the same scene may have
      // overwritten it meanwhile; that copy must stay for recovery.
      await ackDeleteResultKey(resultRedisKey, resultData)
    }

    res.json({ ok: true })
  })

  // ======================================================
  // ERROR
  // ======================================================
  // PW-4 FAIL CLOSED: claimer-only, credential required, symmetric with
  // /task/result.

  app.post("/task/error", async (req, res) => {

    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;

    const { job_id, build_id, dispatch_id, protocol_version, reason } = req.body
    if (!job_id || !build_id || !dispatch_id || protocol_version !== PROTOCOL_VERSION) {
      return res.status(400).json({ error: "invalid" })
    }

    console.log("❌ Error:", job_id, reason || "")

    // Read running info before deleting
    let runningInfo = null;
    try {
      const raw = await redis.hget("animastor:running", job_id);
      if (raw) {
        runningInfo = JSON.parse(raw);
      }
    } catch (_) {}
    if (!runningInfo || runningInfo.dispatch_id !== dispatch_id) {
      return rejectStaleDispatch(res, 'Error', { job_id, build_id, dispatch_id, runningInfo, auth, workerReason: reason })
    }

    // PW-4 claimer check (symmetric with /task/result). SH-1: borrowed
    // (system-pool) claims on private workers finish normally too —
    // claim bound to the credential, not the policy.
    if (runningInfo.worker !== auth.worker_id ||
        !taskLaneMatch(runningInfo, auth)) {
      console.error(`🚫 Error rejected (not claimer): job=${job_id} submitter=${auth.worker_id} claimer=${runningInfo.worker}`);
      return res.status(403).json({ error: "not_task_claimer" })
    }

    await redis.hdel("animastor:running", job_id)
    await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
    if (runningInfo.task_raw) {
      await redis.lrem("animastor:processing", 1, runningInfo.task_raw).catch(() => {})
    }

    // Освобождаем dedup очереди для будущего re-dispatch.
    await redis.del(jobDedupKey(job_id, dispatch_id)).catch(() => {})

    // Clear busy flag from worker heartbeat (scope fields per VISIBILITY note).
    if (runningInfo.worker && runningInfo.job_type) {
      try {
        const hbKey = `animastor:worker:heartbeat:${runningInfo.job_type}:${runningInfo.worker}`;
        const hbPayload = {
          type: runningInfo.job_type,
          worker_id: runningInfo.worker,
          ts: Date.now(),
          current_job_id: null,
          current_dispatch_id: null,
          workspace_id: (runningInfo.worker_mode === 'private'
              && runningInfo.workspace_id == null
              && runningInfo.worker_workspace_id != null)
            ? runningInfo.worker_workspace_id
            : (runningInfo.workspace_id || null),
          mode: runningInfo.worker_mode || null,
          version: runningInfo.worker_version || null,
          image_tag: runningInfo.worker_image_tag || null,
          protocol_version: runningInfo.worker_protocol_version || null
        };
        const sp = runningInfo.worker_share_policy;
        if (sp && activeSharePolicy(sp)) {
          hbPayload.share_policy = { policy_id: sp.policy_id, scope_kind: sp.scope_kind, expires_at: sp.expires_at };
        }
        await redis.set(hbKey, JSON.stringify(hbPayload), 'EX', 30);
      } catch (_) {}
    }

    // T3: форвард ошибки в backend → orchestrator.failStage
    await notifyBackendError(job_id, build_id, dispatch_id, reason || "worker_error", {
      worker_id: runningInfo.worker || null,
      workspace_id: runningInfo.workspace_id || null
    }, errorClassFields(req.body))

    res.json({ ok: true })
  })

  // ======================================================
  // WORKER SOURCE (Experimental Beta — onboarding) — DEPRECATED
  // ======================================================
  // DEPRECATED (Private Worker Setup Contract Phase 3): serves worker.cjs
  // ONLY. The worker requires additional runtime files (worker-cleanup.cjs,
  // worker-cleanup-journal.cjs, package*.json, .env.example), so a
  // single-file install is broken. Canonical replacement: GET /worker-bundle
  // (full versioned bundle, sha256 published at /worker-bundle/sha256).
  // Kept for backward compatibility with the old instruction; no secrets
  // here — same file as worker/worker/worker.cjs, mounted read-only.

  const WORKER_SOURCE_PATH =
    config.WORKER_SOURCE_PATH || "/app/worker-source/worker.cjs";

  app.get("/worker-source", (req, res) => {
    fs.readFile(WORKER_SOURCE_PATH, (err, buf) => {
      if (err) {
        return res.status(404).json({ error: "worker_source_unavailable" });
      }
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="worker.cjs"');
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Deprecation", "true");
      res.setHeader("Link", '</worker-bundle>; rel="successor-version"');
      res.send(buf);
    });
  });

  // ======================================================
  // SETUP CONTRACT ARTIFACTS (Private Worker — Phase 3)
  // ======================================================
  // Public download endpoints behind the UI-safe setup contract metadata
  // served by the backend (GET /api/v1/private-worker/setup/*). Artifacts
  // carry NO secrets: the Worker Key is never part of any bundle — it is
  // entered interactively on the GPU machine. Integrity: every artifact
  // publishes a sha256 (signature infrastructure is a future extension).
  //
  //   GET /worker-bundle          full worker runtime bundle (tar.gz)
  //   GET /worker-bundle/sha256   bundle checksum + version metadata
  //   GET /workflow/:id           baseline workflow JSON (editable-baseline)
  //   GET /installer              installer package (tar.gz, self-contained)
  //   GET /installer/sha256       installer checksum + version metadata

  // ======================================================
  // ARTIFACT DIRECTORY RESOLUTION (Phase 10T precedence fix)
  // ======================================================
  // Order:
  //   1. explicit config/env override — MUST be a readable directory,
  //      otherwise startup fails LOUDLY (never a silent fallback);
  //   2. live bind mount at the frozen /app/... target — a mounted local
  //      source always beats the baked-in copy;
  //   3. baked-in /app/artifacts/<name> — only when nothing is mounted
  //      (images built with artifact bake-in keep working standalone);
  //   4. the frozen mount target — routes then answer the frozen 404
  //      tokens (DEPLOYMENT.md), never a stale baked-in artifact.
  // The previous shipped order was config > baked-in > mount, which
  // silently ignored local dev mounts (mounted installer 0.1.0 was served
  // as baked-in 1.3.0, mounted worker 2.1.1 as baked-in 2.1.0).
  const ARTIFACT_BASE = path.join(__dirname, "artifacts");

  function resolveArtifactDir(configKey, mountFallback, bakedInName) {
    let chosen;
    let source;
    const configured = config[configKey];
    if (configured) {
      let isDir = false;
      try { isDir = fs.statSync(configured).isDirectory(); } catch (_) {}
      if (!isDir) {
        throw new Error(
          `${configKey}="${configured}" is not a readable directory — ` +
          "refusing to start instead of silently serving baked-in/mount artifacts"
        );
      }
      chosen = configured;
      source = "config";
    } else if (fs.existsSync(mountFallback)) {
      chosen = mountFallback;
      source = "mount";
    } else if (bakedInName && fs.existsSync(path.join(ARTIFACT_BASE, bakedInName))) {
      chosen = path.join(ARTIFACT_BASE, bakedInName);
      source = "baked-in";
    } else {
      chosen = mountFallback;
      source = "missing → frozen 404";
    }
    console.log(`[ARTIFACTS] ${configKey} = ${chosen} (${source})`);
    return chosen;
  }

  const WORKER_BUNDLE_DIR =
    resolveArtifactDir("WORKER_BUNDLE_DIR", "/app/worker-bundle", "worker-bundle");
  const WORKFLOW_DIR =
    resolveArtifactDir("WORKFLOW_DIR", "/app/workflows", "workflows");
  const INSTALLER_SRC_DIR =
    resolveArtifactDir("INSTALLER_SRC_DIR", "/app/installer-src", "installer-src");
  const INSTALLER_MANIFESTS_DIR =
    resolveArtifactDir("INSTALLER_MANIFESTS_DIR", "/app/install-manifests", "install-manifests");
  const INSTALLER_WORKFLOWS_DIR =
    resolveArtifactDir("INSTALLER_WORKFLOWS_DIR", "/app/workflows", "workflows");
  // Canonical installer VERSION source (the package root). Separate mount:
  // the flat installer-src mount carries no package.json (the bake-in
  // Dockerfile flattens the canonical package.json into installer-src/), and
  // a file bind-mount nested inside the read-only installer-src dir mount is
  // rejected by runc — so the package root is mounted beside it instead.
  const INSTALLER_PKG_DIR =
    resolveArtifactDir("INSTALLER_PKG_DIR", "/app/installer-pkg", null);

  const artifactDirs = {
    WORKER_BUNDLE_DIR,
    WORKFLOW_DIR,
    INSTALLER_SRC_DIR,
    INSTALLER_MANIFESTS_DIR,
    INSTALLER_WORKFLOWS_DIR,
    INSTALLER_PKG_DIR,
  };

  // Versions have ONE canonical source each (no manual duplication):
  //   worker bundle → worker/worker/package.json (mounted as WORKER_BUNDLE_DIR)
  //   installer     → backend/src/installer/package.json (INSTALLER_SRC_DIR)
  // The hub reads them at request time; config overrides exist for tests.
  function readCanonicalVersion(dir, fallbackName) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg && typeof pkg.version === "string" && pkg.version) {
        return { version: pkg.version, name: pkg.name || fallbackName, description: pkg.description || null };
      }
    } catch (_) { /* canonical package.json missing/unreadable */ }
    return null;
  }

  function workerBundleMeta() {
    const canonical = readCanonicalVersion(WORKER_BUNDLE_DIR, "animastor-worker");
    return {
      version: config.WORKER_BUNDLE_VERSION || (canonical && canonical.version) || null,
      name: (canonical && canonical.name) || "animastor-worker",
    };
  }

  function installerMeta() {
    // Version source: the canonical package root when it is mounted
    // (INSTALLER_PKG_DIR), else the package.json inside INSTALLER_SRC_DIR
    // (bake-in layout / deployments that keep it in the flat mount).
    const canonical =
      readCanonicalVersion(INSTALLER_PKG_DIR, "animastor-installer") ||
      readCanonicalVersion(INSTALLER_SRC_DIR, "animastor-installer");
    return {
      version: config.INSTALLER_VERSION || (canonical && canonical.version) || null,
      name: (canonical && canonical.name) || "animastor-installer",
      description: canonical && canonical.description,
    };
  }

  // A file is servable only if it cannot be a secret: `.env` and any
  // `.env.*` variant are NEVER included (defense in depth — the mounted
  // directory must not contain them, but we never trust the mount alone).
  function isServableBundleFile(relPath) {
    const base = relPath.split("/").pop();
    if (base === ".env" || /^\.env\..+$/.test(base)) return base === ".env.example";
    return true;
  }

  // Deterministic artifact cache: rebuilt only when the source tree changes
  // (fingerprint = sorted relpath + size + mtime of every included file).
  function cachedArtifact(cache, fingerprintFn, buildFn) {
    let fingerprint = null;
    try { fingerprint = fingerprintFn(); } catch (_) { return null; }
    if (!fingerprint) return null;
    if (cache.fingerprint === fingerprint) return cache.artifact;
    const artifact = buildFn();
    cache.fingerprint = fingerprint;
    cache.artifact = artifact;
    return artifact;
  }

  function dirFingerprint(dir, filter) {
    if (!fs.existsSync(dir)) return null;
    const files = walkDir(fs, dir).filter((f) => !filter || filter(f)).sort();
    if (files.length === 0) return null;
    const parts = [];
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    }
    return parts.join("|");
  }

  function buildBundleArtifact() {
    const files = walkDir(fs, WORKER_BUNDLE_DIR)
      .filter(isServableBundleFile)
      .sort();
    const entries = files.map((f) => ({
      name: `animastor-worker/${f}`,
      data: fs.readFileSync(path.join(WORKER_BUNDLE_DIR, f)),
    }));
    const buffer = buildTarGz(entries);
    return {
      buffer,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      files,
      bytes: buffer.length,
    };
  }

  const workerBundleCache = { fingerprint: null, artifact: null };

  app.get("/worker-bundle", (req, res) => {
    const meta = workerBundleMeta();
    const artifact = meta.version && cachedArtifact(
      workerBundleCache,
      () => dirFingerprint(WORKER_BUNDLE_DIR, isServableBundleFile),
      buildBundleArtifact
    );
    if (!artifact) {
      // No canonical version (package.json missing) or no files — never
      // serve a versionless artifact.
      return res.status(404).json({ error: "worker_bundle_unavailable" });
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${meta.name}-${meta.version}.tar.gz"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Animastor-Artifact-Version", meta.version);
    res.setHeader("X-Animastor-Sha256", artifact.sha256);
    res.send(artifact.buffer);
  });

  app.get("/worker-bundle/sha256", (req, res) => {
    const meta = workerBundleMeta();
    const artifact = meta.version && cachedArtifact(
      workerBundleCache,
      () => dirFingerprint(WORKER_BUNDLE_DIR, isServableBundleFile),
      buildBundleArtifact
    );
    if (!artifact) {
      return res.status(404).json({ error: "worker_bundle_unavailable" });
    }
    res.json({
      artifact: "worker-bundle",
      version: meta.version,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      files: artifact.files,
      signature: null, // future: signature + signature_algorithm
    });
  });

  // Baseline workflows (editable-baseline policy). The allowlist is derived
  // from the canonical install manifests — legacy/excluded workflow files
  // (old_*.json) are never served. The id is the manifest workflow id
  // without the "workflow:" prefix (e.g. img-qwen-image).
  const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

  function loadWorkflowAllowlist() {
    const allow = new Map();
    if (!fs.existsSync(INSTALLER_MANIFESTS_DIR)) return allow;
    for (const type of fs.readdirSync(INSTALLER_MANIFESTS_DIR).sort()) {
      const typeDir = path.join(INSTALLER_MANIFESTS_DIR, type);
      if (!fs.statSync(typeDir).isDirectory()) continue;
      for (const file of fs.readdirSync(typeDir).sort()) {
        if (!file.endsWith(".json")) continue;
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(typeDir, file), "utf8"));
        } catch (_) { continue; }
        const profileId = manifest.profile && manifest.profile.id;
        const artifacts =
          manifest.workflows && Array.isArray(manifest.workflows.artifacts)
            ? manifest.workflows.artifacts
            : [];
        for (const wf of artifacts) {
          if (!wf || !wf.id || !wf.filename) continue;
          allow.set(String(wf.id).replace(/^workflow:/, ""), {
            filename: wf.filename,
            name: wf.name || null,
            profile_id: profileId || null,
            baseline_sha256: wf.baseline_sha256 || null,
          });
        }
      }
    }
    return allow;
  }

  app.get("/workflow/:id", (req, res) => {
    const id = req.params.id;
    if (!WORKFLOW_ID_RE.test(id)) {
      return res.status(404).json({ error: "workflow_not_found" });
    }
    const meta = loadWorkflowAllowlist().get(id);
    if (!meta) {
      return res.status(404).json({ error: "workflow_not_found" });
    }
    const filePath = path.resolve(WORKFLOW_DIR, meta.filename);
    // Path traversal defense: resolved path must stay inside WORKFLOW_DIR.
    if (!filePath.startsWith(path.resolve(WORKFLOW_DIR) + path.sep)) {
      return res.status(404).json({ error: "workflow_not_found" });
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        return res.status(404).json({ error: "workflow_unavailable" });
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${meta.filename}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "X-Animastor-Sha256",
        crypto.createHash("sha256").update(buf).digest("hex")
      );
      res.send(buf);
    });
  });

  // ======================================================
  // BOOTSTRAP INSTALLER (Private Worker onboarding — Phase 3.2)
  // ======================================================
  // GET /installer serves a small, auditable bootstrap LAUNCHER SCRIPT (not
  // a tarball): the user downloads and runs it on the GPU machine and it does
  // the whole flow — download the installer bundle (GET /installer/bundle),
  // verify its sha256 against the hub-published checksum (GET
  // /installer/sha256), unpack into a temp dir and run the real installer
  // CLI. The profile/mode selected in the web onboarding are embedded into
  // the script at download time (query params, validated against the
  // canonical manifest allowlist — they are NOT secrets). The Worker Key is
  // NEVER part of this exchange: the installer asks for it interactively.
  //
  // The launcher script ITSELF is the platform choice (the platform is
  // auto-detected by which script the user runs — never a CLI flag):
  //   ?platform=linux   → bash launcher (animastor-installer.sh, default)
  //   ?platform=windows → PowerShell launcher (animastor-installer.ps1)
  // Without ?platform the hub sniffs the User-Agent: a Windows browser
  // download gets the PowerShell launcher automatically.
  //
  //   GET /installer            bootstrap launcher script
  //                             ?profile=<id>&mode=<mode>&platform=<p>
  //   GET /installer/bundle     self-contained installer package (tar.gz)
  //   GET /installer/sha256     installer checksum + version metadata

  // This hub's own version (package.json) — embedded into the bootstrap for
  // the installer banner.
  const HUB_PACKAGE_VERSION = (() => {
    try { return require("./package.json").version || null; } catch (_) { return null; }
  })();

  // Modes the bootstrap may embed — mirrors the setup contract INSTALL_MODES.
  const BOOTSTRAP_MODES = new Set(["managed", "existing", "shared", "isolated"]);

  // Canonical profile allowlist from the install manifests (hidden/internal
  // profiles are never embeddable). Rebuilt with the same freshness rules as
  // the workflow allowlist.
  function loadProfileAllowlist() {
    const allow = new Set();
    if (!fs.existsSync(INSTALLER_MANIFESTS_DIR)) return allow;
    for (const type of fs.readdirSync(INSTALLER_MANIFESTS_DIR).sort()) {
      const typeDir = path.join(INSTALLER_MANIFESTS_DIR, type);
      if (!fs.statSync(typeDir).isDirectory()) continue;
      for (const file of fs.readdirSync(typeDir).sort()) {
        if (!file.endsWith(".json")) continue;
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(typeDir, file), "utf8"));
        } catch (_) { continue; }
        const id = manifest.profile && manifest.profile.id;
        const status = manifest.status;
        if (!id || status === "internal" || status === "hidden") continue;
        allow.add(id);
      }
    }
    return allow;
  }

  // The hub does not know its own public origin (it lives behind nginx), so
  // the bootstrap embeds it from the forwarded Host. Only a clean DNS-name
  // Host is accepted — anything else falls back to the canonical origin.
  const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

  function publicHubUrl(req) {
    if (config.PUBLIC_HUB_URL) return String(config.PUBLIC_HUB_URL).replace(/\/$/, "");
    const host = req && req.headers && typeof req.headers.host === "string" ? req.headers.host : "";
    if (HOSTNAME_RE.test(host)) return `https://${host}/gpu`;
    return "https://animastor.org/gpu";
  }

  app.get("/installer", (req, res) => {
    const meta = installerMeta();
    if (!meta.version) {
      return res.status(404).json({ error: "installer_unavailable" });
    }
    // Optional onboarding context: profile/mode baked into the script so the
    // user never types them. Fail closed on invalid values (never silently
    // degrade — a wrong profile would produce a confusing install later).
    let profile = null;
    if (req.query.profile !== undefined) {
      const raw = String(req.query.profile);
      const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const allow = loadProfileAllowlist();
      if (ids.length === 0 || !ids.every((id) => allow.has(id))) {
        return res.status(400).json({ error: "invalid_profile" });
      }
      profile = ids.join(",");
    }
    let mode = null;
    if (req.query.mode !== undefined) {
      mode = String(req.query.mode);
      if (!BOOTSTRAP_MODES.has(mode)) {
        return res.status(400).json({ error: "invalid_mode" });
      }
    }
    // Platform choice (bash vs PowerShell launcher). Explicit query param
    // wins; otherwise a Windows User-Agent gets the PowerShell launcher.
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
    const platformParam = req.query.platform !== undefined ? String(req.query.platform) : null;
    let targetPlatform = "linux";
    if (platformParam === "windows") targetPlatform = "windows";
    else if (platformParam === "linux") targetPlatform = "linux";
    else if (platformParam !== null) return res.status(400).json({ error: "invalid_platform" });
    else if (/Windows/i.test(ua)) targetPlatform = "windows";
    const common = {
      hubUrl: publicHubUrl(req),
      profile,
      mode,
      installerVersion: meta.version,
      // Shown in the installer banner (non-secret): this hub's package
      // version and the worker bundle version it serves.
      hubVersion: HUB_PACKAGE_VERSION,
      workerBundleVersion: workerBundleMeta().version,
    };
    const headers = {
      "Cache-Control": "no-store",
      "X-Animastor-Bootstrap-Version": BOOTSTRAP_VERSION,
      "X-Animastor-Artifact-Version": meta.version,
    };
    if (targetPlatform === "windows") {
      const script = buildWindowsBootstrapScript(common);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="animastor-installer.ps1"');
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.send(script);
    }
    const script = buildBootstrapScript(common);
    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="animastor-installer.sh"');
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.send(script);
  });

  // Installer package — self-contained: installer sources + canonical
  // install manifests + the full worker bundle + generated root
  // package.json/README. Layout mirrors the repo (src/installer/*,
  // ai/install-manifests/*, worker/worker/*) so install-manifest.js and the
  // engine resolve their inputs without modification. The version comes
  // from the canonical backend/src/installer/package.json — never hardcoded
  // here. No Worker Key, no .env, no credentials.
  function buildInstallerArtifact() {
    const meta = installerMeta();
    if (!meta.version) return null; // no canonical version → not publishable
    const entries = [];
    const srcFiles = walkDir(fs, INSTALLER_SRC_DIR).sort();
    for (const f of srcFiles) {
      entries.push({
        name: `animastor-installer/src/installer/${f}`,
        data: fs.readFileSync(path.join(INSTALLER_SRC_DIR, f)),
      });
    }
    const manifestFiles = walkDir(fs, INSTALLER_MANIFESTS_DIR).sort();
    for (const f of manifestFiles) {
      entries.push({
        name: `animastor-installer/ai/install-manifests/${f}`,
        data: fs.readFileSync(path.join(INSTALLER_MANIFESTS_DIR, f)),
      });
    }
    // Baseline workflows — the installer reads them from <repo>/backend/ai/workflows/.
    // Including them in the tarball lets the repo_path source work even when the
    // installer runs on a machine without a full Animastor checkout.
    let workflowFiles = [];
    try { workflowFiles = walkDir(fs, INSTALLER_WORKFLOWS_DIR).sort(); } catch (_) { /* dir may not exist in test */ }
    for (const f of workflowFiles) {
      entries.push({
        name: `animastor-installer/backend/ai/workflows/${f}`,
        data: fs.readFileSync(path.join(INSTALLER_WORKFLOWS_DIR, f)),
      });
    }
    // The engine deploys the worker bundle from <installer>/worker/worker/
    // (manifest worker_bundle.files). Without these files a distributed
    // installer could never install the worker offline — the install on the
    // GPU machine would always fail with "could not obtain bundle files".
    const workerFiles = walkDir(fs, WORKER_BUNDLE_DIR)
      .filter(isServableBundleFile)
      .sort();
    for (const f of workerFiles) {
      entries.push({
        name: `animastor-installer/worker/worker/${f}`,
        data: fs.readFileSync(path.join(WORKER_BUNDLE_DIR, f)),
      });
    }
    entries.push({
      name: "animastor-installer/package.json",
      data: JSON.stringify(
        {
          name: meta.name,
          version: meta.version,
          private: true,
          description: meta.description
            || "Animastor Private GPU Worker installer (setup contract distribution)",
          bin: { [meta.name]: "src/installer/cli.js" },
          engines: { node: ">=20" },
        },
        null,
        2
      ) + "\n",
    });
    entries.push({
      name: "animastor-installer/README.txt",
      data: [
        "Animastor Private GPU Worker installer",
        "",
        "Usage:",
        "  node src/installer/cli.js detect",
        "  node src/installer/cli.js plan --profile audio/qwen-tts",
        "  node src/installer/cli.js install --profile audio/qwen-tts --yes",
        "",
        "  Managed mode (default) starts ComfyUI and the worker automatically",
        "  and picks a free port when 8188 is already taken. Remembered across",
        "  re-runs — a bare re-run keeps the same wiring. Opt out with",
        "  --no-start-comfy / --no-start-worker, pin a port with --comfy-port N.",
        "",
        "  --accept-reference-runtime  install the manifest's known-working reference",
        "                              ComfyUI while the canonical pin is open (D1)",
        "",
        "The Worker Key is asked interactively on this machine (hidden input).",
        "It is never logged, never stored in installer state, never passed via argv.",
        "",
      ].join("\n"),
    });
    const buffer = buildTarGz(entries);
    return {
      buffer,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
      files: entries.map((e) => e.name),
    };
  }

  const installerCache = { fingerprint: null, artifact: null };

  function installerFingerprint() {
    const a = dirFingerprint(INSTALLER_SRC_DIR);
    const b = dirFingerprint(INSTALLER_MANIFESTS_DIR);
    const c = dirFingerprint(WORKER_BUNDLE_DIR, isServableBundleFile);
    const d = dirFingerprint(INSTALLER_WORKFLOWS_DIR);
    const meta = installerMeta();
    return a && b && meta.version ? `${meta.version}|${a}|${b}|${c || "no-worker-bundle"}|${d || "no-workflows"}` : null;
  }

  app.get("/installer/bundle", (req, res) => {
    const meta = installerMeta();
    const artifact = cachedArtifact(installerCache, installerFingerprint, buildInstallerArtifact);
    if (!artifact) {
      return res.status(404).json({ error: "installer_unavailable" });
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${meta.name}-${meta.version}.tar.gz"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Animastor-Artifact-Version", meta.version);
    res.setHeader("X-Animastor-Sha256", artifact.sha256);
    res.send(artifact.buffer);
  });

  app.get("/installer/sha256", (req, res) => {
    const meta = installerMeta();
    const artifact = cachedArtifact(installerCache, installerFingerprint, buildInstallerArtifact);
    if (!artifact) {
      return res.status(404).json({ error: "installer_unavailable" });
    }
    res.json({
      artifact: "installer",
      version: meta.version,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      signature: null, // future: signature + signature_algorithm
    });
  });

  // ======================================================
  // HEALTH
  // ======================================================

  app.get("/health", async (req, res) => {

    const queues = {
      image: await redis.llen("animastor:queue:image"),
      audio: await redis.llen("animastor:queue:audio"),
      video: await redis.llen("animastor:queue:video")
    }

    // PW-2: workspace queue depths (discovered, never hardcoded).
    const workspaceQueues = {};
    for (const key of await discoverQueueKeys()) {
      const m = key.match(/^animastor:queue:(audio|image|video):ws:(.+)$/);
      if (!m) continue;
      workspaceQueues[key] = await redis.llen(key);
    }

    const running = await redis.hlen("animastor:running")
    const gpuCount = (await getAllGpusFromRedis()).size;

    res.json({
      gpus: gpuCount,
      queues,
      workspace_queues: workspaceQueues,
      running
    })
  })

  app.delete("/queue/clear", requireApiKey, async (req, res) => {
    try {
      const { book_id, dispatch_id, workspace_id } = req.query
      // ORCHESTRATION_V2 §3 I7 / §8.4 (stage 1c): the parameterless FULL
      // clear (every queue, running, processing, result:*, job:* of every
      // user) is removed. Clearing is scoped only — book_id, dispatch_id or
      // workspace_id (a concrete workspace queue). Empty values count as
      // absent (`?book_id=` used to fall through to the full clear).
      if (!book_id && !dispatch_id && !workspace_id) {
        return res.status(400).json({ error: "scope_required", message: "DELETE /queue/clear needs book_id, dispatch_id or workspace_id — the full clear is removed" })
      }
      // PW-2: workspace-scoped clear — when workspace_id is given, only that
      // workspace's queues/running entries are touched (guest purge seam).
      const queueKeys = await discoverQueueKeys();
      const scopedKeys = workspace_id
        ? queueKeys.filter(k => k.endsWith(`:ws:${workspace_id}`))
        : queueKeys;
      const summary = { queued: 0, processing: 0, running: 0, results: 0, dedup: 0 }

      if (book_id || dispatch_id || workspace_id) {
        const matches = (record) => {
          if (dispatch_id) return record.dispatch_id === dispatch_id
          if (workspace_id) return (record.workspace_id || null) === workspace_id
          return record.book_id === book_id
        }
        const removedJobs = []

        // 1. Clear queue lists by structured ownership.
        for (const key of scopedKeys) {
          const items = await redis.lrange(key, 0, -1)
          const remaining = []
          for (const item of items) {
            try {
              const parsed = JSON.parse(item)
              if (matches(parsed)) {
                removedJobs.push(parsed)
                summary.queued++
              } else {
                remaining.push(item)
              }
            } catch (_) { remaining.push(item) }
          }
          await redis.del(key)
          if (remaining.length > 0) {
            await redis.rpush(key, ...remaining)
          }
        }

        // 2. Clear running entries by the same ownership fields.
        let cursor = '0'
        do {
          const scan = await redis.hscan('animastor:running', cursor, 'COUNT', 500)
          cursor = scan[0]
          const entries = scan[1]
          if (entries && entries.length > 0) {
            for (let i = 0; i < entries.length; i += 2) {
              const job_id = entries[i]
              const record = JSON.parse(entries[i + 1])
              if (matches(record)) {
                removedJobs.push({ ...record, job_id })
                await redis.hdel('animastor:running', job_id)
                await redis.hdel(PROCESSING_CLAIMED_KEY, job_id).catch(() => {})
                if (record.task_raw) {
                  await redis.lrem('animastor:processing', 1, record.task_raw).catch(() => {})
                }
                summary.running++
              }
            }
          }
        } while (cursor !== '0')

        // 3. Clear result keys. Dispatch-scoped cleanup reads stored identity;
        // book-scoped cleanup can use the structured key segment.
        // Key format: animastor:result:<build_id>:<bookId>:<chapterId>:<sceneId>:<type>
        // Используем SCAN с HSCAN-подобным подходом: итерируем все result ключи и фильтруем по book_id.
        // Аналог animastor:result:*:${book_id}:* — но SCAN с двумя * в начале медленный,
        // поэтому итерируем все animastor:result:* и фильтруем на стороне клиента.
        {
          let c = '0'
          do {
            const scan = await redis.scan(c, 'MATCH', 'animastor:result:*', 'COUNT', 1000)
            c = scan[0]
            const toDelete = []
            for (const key of scan[1]) {
              const parts = key.split(':')
              // Format: animastor:result:<build_id>:<bookId>:...
              // book_id at index 3 (0=animastor,1=result,2=build_id,3=bookId)
              if (dispatch_id) {
                const raw = await redis.get(key)
                try {
                  if (JSON.parse(raw || '{}').dispatch_id === dispatch_id) toDelete.push(key)
                } catch (_) {}
              } else if (book_id && parts.length >= 4 && parts[3] === book_id) {
                toDelete.push(key)
              }
            }
            if (toDelete.length > 0) {
              await redis.del(...toDelete)
              summary.results += toDelete.length
            }
          } while (c !== '0')
        }

        // 4. Clear exact dedup records for removed queue/running jobs.
        for (const job of removedJobs) {
          if (job.job_id && job.dispatch_id) {
            summary.dedup += await redis.del(jobDedupKey(job.job_id, job.dispatch_id))
          }
        }

        console.log(`[QUEUE-CLEAR] Filtered cleanup`, { book_id, dispatch_id, workspace_id, summary })
        res.json({ ok: true, scope: { book_id: book_id || null, dispatch_id: dispatch_id || null, workspace_id: workspace_id || null }, removed: summary })

      }
    } catch (err) {
      console.error("Failed to clear queues:", err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // ======================================================
  // PROTOCOL 3 — RELAY (ORCHESTRATION_V2 ADR §8, I6)
  // ======================================================
  // The hub keeps NO task state on this path: no queue, no running record,
  // no dedup, no result copy, no retries of its own. It authenticates the
  // worker (same Bearer gate as v2) and forwards to the backend
  // (BACKEND_INTERNAL_URL, docker network, x-api-key). Results and errors go
  // from the worker straight to the backend (upload_url / error_url).
  //   GET  /v3/task/next?type=…  → POST {backend}/internal/gen/claim  {worker_id, worker_type}
  //   POST /v3/beacon            → POST {backend}/internal/gen/beacon {worker_id, current_job_id}
  // The ONLY Redis write of the v3 path: /v3/beacon refreshes the hub's own
  // heartbeat key (UI status + legacy worker counts) — exactly what /beacon
  // writes today. Nothing extends liveness from a running record here.

  const V3_RELAY_TIMEOUT_MS = Number(config.V3_RELAY_TIMEOUT_MS) > 0 ? Number(config.V3_RELAY_TIMEOUT_MS) : 10000;
  const V3_BACKEND = config.BACKEND_INTERNAL_URL ? String(config.BACKEND_INTERNAL_URL).replace(/\/+$/, "") : null;

  function v3Unavailable(res) {
    if (!V3_BACKEND) {
      res.status(503).json({ error: "v3_not_configured", message: "BACKEND_INTERNAL_URL is not set on the hub — protocol 3 is unavailable, use /task/next" });
      return true;
    }
    if (!GPU_HUB_API_KEY) {
      res.status(503).json({ error: "hub_api_key_not_configured", message: "GPU_HUB_API_KEY is required for the backend relay" });
      return true;
    }
    return false;
  }

  /** One relay hop, no retries. Resolves {status, body, contentType} or throws on network error / timeout. */
  async function relayToBackend(p, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), V3_RELAY_TIMEOUT_MS);
    try {
      const r = await doFetch(`${V3_BACKEND}${p}`, {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await r.text();
      const contentType = (r.headers && typeof r.headers.get === "function" && r.headers.get("content-type")) || "application/json";
      return { status: r.status, body, contentType };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Backend answer → worker, as is. A rejected HUB key is the hub's misconfiguration, never the worker's: 502. */
  function forwardRelay(res, out, what) {
    if (out.status === 401) {
      console.error(`[V3] backend rejected the hub key on ${what} (HTTP 401) — check GPU_HUB_API_KEY on hub and backend`);
      return res.status(502).json({ error: "backend_rejected_hub_key" });
    }
    res.status(out.status).type(out.contentType).send(out.body);
  }

  function relayFailed(res, err, what) {
    const reason = err && err.name === "AbortError" ? `timeout ${V3_RELAY_TIMEOUT_MS}ms` : String((err && err.message) || err);
    console.warn(`[V3] ${what} relay failed: ${reason}`);
    return res.status(503).json({ error: "backend_unavailable", message: `backend ${what} relay failed: ${reason}` });
  }

  app.get("/v3/task/next", async (req, res) => {
    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;
    if (v3Unavailable(res)) return;
    const { type } = req.query;
    if (type && auth.worker_type !== type) {
      return res.status(409).json({ error: "worker_type_mismatch", registered: auth.worker_type, requested: type });
    }
    let out;
    try {
      out = await relayToBackend("/internal/gen/claim", { worker_id: auth.worker_id, worker_type: auth.worker_type });
    } catch (err) {
      return relayFailed(res, err, "claim");
    }
    return forwardRelay(res, out, "claim");
  });

  app.post("/v3/beacon", async (req, res) => {
    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;
    if (v3Unavailable(res)) return;
    const { version, image_tag } = req.body || {};
    const currentJobId = typeof (req.body || {}).current_job_id === "string" && req.body.current_job_id ? req.body.current_job_id : null;
    // The hub's own heartbeat (UI status, legacy counts) — same key and shape as /beacon.
    try {
      const payload = {
        type: auth.worker_type,
        worker_id: auth.worker_id,
        ts: Date.now(),
        workspace_id: auth.workspace_id || null,
        mode: auth.mode || null,
        version: version || null,
        image_tag: image_tag || null,
        protocol_version: 3,
        current_job_id: currentJobId,
      };
      const marker = sharePolicyMarker(auth);
      if (marker) payload.share_policy = marker;
      await redis.set(`animastor:worker:heartbeat:${auth.worker_type}:${auth.worker_id}`, JSON.stringify(payload), 'EX', 30);
    } catch (_) {}
    let out;
    try {
      out = await relayToBackend("/internal/gen/beacon", { worker_id: auth.worker_id, current_job_id: currentJobId });
    } catch (err) {
      return relayFailed(res, err, "beacon");
    }
    return forwardRelay(res, out, "beacon");
  });

  // POST /v3/logs — fresh worker logs (ORCHESTRATION_V2 §8.5).
  // The worker sends a gzip JSON body {worker_id, seq_from, seq_to, lines[]}
  // with its Bearer. The hub: authenticates with the SAME worker gate, keeps
  // NO copy (no Redis write), enforces a 128 KiB wire limit (413 beyond it)
  // and forwards the parsed body to the backend inside the docker network.
  // The backend URL identity is the token's worker_id — the body's worker_id
  // is a label and is never trusted.
  const V3_LOG_BODY_LIMIT = Number(config.V3_LOG_BODY_LIMIT) > 0 ? Number(config.V3_LOG_BODY_LIMIT) : 128 * 1024;
  const V3_LOG_INFLATED_LIMIT = Number(config.V3_LOG_INFLATED_LIMIT) > 0 ? Number(config.V3_LOG_INFLATED_LIMIT) : 1024 * 1024;

  /** Read the request body with a hard byte ceiling (413 semantics). */
  function readRawBodyLimited(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        // Drain the rest instead of destroying the socket: the caller still
        // needs to deliver the 413/400 answer over this connection.
        try { req.resume(); } catch (_) {}
        reject(err);
      };
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) return fail(Object.assign(new Error("payload too large"), { code: "too_large" }));
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      req.on("error", (err) => fail(err));
    });
  }

  function decodeLogBody(raw, encoding) {
    let buf = raw;
    const enc = String(encoding || "").toLowerCase();
    if (enc.includes("gzip")) {
      buf = zlib.gunzipSync(raw, { maxOutputLength: V3_LOG_INFLATED_LIMIT });
    } else if (enc.includes("deflate")) {
      buf = zlib.inflateSync(raw, { maxOutputLength: V3_LOG_INFLATED_LIMIT });
    } else if (buf.length > V3_LOG_INFLATED_LIMIT) {
      throw Object.assign(new Error("payload too large"), { code: "too_large" });
    }
    return JSON.parse(buf.toString("utf8"));
  }

  app.post("/v3/logs", async (req, res) => {
    const auth = await requireWorkerCredential(redis, req, res);
    if (!auth) return;
    if (v3Unavailable(res)) return;
    let raw;
    try {
      raw = await readRawBodyLimited(req, V3_LOG_BODY_LIMIT);
    } catch (err) {
      if (err && err.code === "too_large") {
        return res.status(413).json({ error: "payload_too_large", message: `limit ${V3_LOG_BODY_LIMIT} bytes` });
      }
      return res.status(400).json({ error: "bad_request", message: "could not read the body" });
    }
    let payload;
    try {
      payload = decodeLogBody(raw, req.headers["content-encoding"]);
    } catch (err) {
      if (err && (err.code === "too_large" || err.code === "ERR_BUFFER_TOO_LARGE" || err.code === "ERR_OUT_OF_RANGE")) {
        return res.status(413).json({ error: "payload_too_large" });
      }
      return res.status(400).json({ error: "invalid_json" });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.lines)) {
      return res.status(400).json({ error: "bad_request", message: "lines[] required" });
    }
    let out;
    try {
      out = await relayToBackend(`/internal/workers/${auth.worker_id}/logs`, payload);
    } catch (err) {
      return relayFailed(res, err, "logs");
    }
    return forwardRelay(res, out, "logs");
  });

  // Expose internals for tests / server.js lifecycle.
  app.__hub = {
    redis,
    sweepProcessingOrphans,
    heartbeatAndTimeoutSweep,
    artifactDirs,
    // Canonical origin embedded into the /installer bootstrap (tests pin the
    // fallback so the stale-domain regression cannot come back silently).
    publicHubUrl,
    stopIntervals: () => { if (intervalTimer) clearInterval(intervalTimer); },
  };

  return app
}

// ======================================================
// STANDALONE START (server.js requires this module)
// ======================================================

if (require.main === module) {
  const REDIS_URL = process.env.REDIS_URL || "redis://animastor-redis:6379";
  const redis = new (require("ioredis"))(REDIS_URL);
  const { PORT = 5000 } = process.env;

  const app = buildHubApp({
    redis,
    config: {
      ...artifactDirEnvConfig(),
      BACKEND_URL: process.env.BACKEND_URL || "http://animastor-backend:3000",
      // Protocol 3 relay target (ORCHESTRATION_V2 §8): the backend inside the docker
      // network, e.g. http://animastor-backend:3000. Unset → /v3/* answer 503.
      BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL || null,
      GPU_TIMEOUT_MS: Number(process.env.GPU_TIMEOUT_MS ?? process.env.GPU_TIMEOUT ?? 600000),
      GPU_HUB_API_KEY: process.env.GPU_HUB_API_KEY || null,
      GPU_HUB_ALLOW_OPEN: process.env.GPU_HUB_ALLOW_OPEN || null,
      PUBLIC_HUB_URL: process.env.PUBLIC_HUB_URL || null,
    },
  });

  const server = app.listen(PORT, () => {
    console.log("🚀 GPU HUB running on", PORT)
  })

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log("[SHUTDOWN] SIGTERM received, shutting down...");
    app.__hub.stopIntervals();
    server.close(() => {
      console.log("[SHUTDOWN] HTTP server closed");
    });
    try {
      await redis.quit();
      console.log("[SHUTDOWN] Redis connection closed");
    } catch (_) {}
    console.log("[SHUTDOWN] Goodbye");
    process.exit(0);
  });
}

module.exports = {
  PROTOCOL_VERSION,
  createAccessLog,
  ACCESS_SUMMARY_MS,
  WORKER_AUTH_MIRROR_KEY,
  PROCESSING_CLAIMED_KEY,
  DEAD_LETTER_KEY,
  ORPHAN_GRACE_MS,
  MAX_ORPHAN_REQUEUES,
  parseWorkerToken,
  extractBearerToken,
  authenticateWorkerMirror,
  requireWorkerCredential,
  buildHubApp,
  // Artifact dir env forwarding (server.js config seam)
  artifactDirEnvConfig,
  // SH-1 test/ops surface (worker sharing V1)
  sanitizeSharePolicy,
  activeSharePolicy,
};
