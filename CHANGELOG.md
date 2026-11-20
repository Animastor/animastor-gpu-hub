# Changelog

## Unreleased

### Changed (release workflow — existing image_tag is refused)

- `ghcr-release.yml` fails when `image_tag` already exists in GHCR, before the
  build and again right before `docker push` (race with a parallel run).
  `.github/scripts/ghcr-tag-absent.sh`: manifest HEAD via the registry token
  endpoint; `404` → continue, `200` → fail, anything else / no credentials /
  timeout → fail (fail closed). Credentials go to curl through `-K -` (stdin),
  never argv. Tests: `tests/run-all.cjs` — 5 checks with a stub `curl`
  (404/200/401/403/500/000, token failure, no creds, no secret in argv/output,
  guard placement in the workflow). Reason: owner request after the v0.3.5
  release (a re-run on a taken tag would silently move it to another digest).

### Changed (v0.3.5, VBook v4 release — artifacts repin)

- `artifacts.lock.json`: worker `8745ca9` (main, merge of `feat/voice-references`;
  bundle 2.5.0, 9 files — only the result-contract comment in `worker.cjs` changed),
  backend `045328c` (main, merge of `feat/vbook-v4`): installer-src **0.2.11**,
  workflows 11 files (voice-reference + transcribe), install-manifests with
  `custom-node:animastor-voice-ref` (`SaveAudioAnimastorReference`, worker `6a88ad9`).

### Changed (v0.3.5, VBook v4 release — owner decision, step 6 Q2)

- **No default infra hosts.** `REDIS_URL` and `BACKEND_URL` are required; the
  `redis://animastor-redis:6379` / `http://animastor-backend:3000` fallbacks are
  gone from `server.js` and the standalone start of `gpu-hub.js`. A missing value
  prints one line `[FATAL] REDIS_URL is not set; BACKEND_URL is not set — …` and
  exits 1 before Redis is touched (`requiredInfraEnv` / `requireInfraEnvOrExit`).
  Reason: on a host with a wildcard DNS search domain a short docker name of an
  absent container resolves to a stranger's machine and would receive the Redis
  password / task callbacks. Deploy must set `BACKEND_URL` explicitly (prod
  compose relied on the default). CI smokes pass `BACKEND_URL`. Tests:
  `tests/run-all.cjs` — 5 checks (no literal fallbacks, FATAL for both entry
  points, partial env, helper).

### Added

- **Access log (v0.3.3, reports/2026-11-07/orch-v2-image-scene-run.md О3).** One
  line per request — `[HTTP] <METHOD> <path> → <status> worker=<worker_id|-> <ms>ms`
  — for `/v3/*` and the legacy paths; the path is printed without the query string,
  headers and bodies are never printed (no tokens or keys); `worker_id` is
  token-derived (`requireWorkerCredential`). Idle traffic — an empty task poll
  (`{"task":null}` from `/task/next` and `/v3/task/next`), a 2xx beacon, `/health` —
  is folded into one summary line per minute
  (`[HTTP] idle 60s: GET /v3/task/next empty ×12, POST /v3/beacon 200 ×6 (workers 2)`).
  `createAccessLog` exported; test `tests/access-log.cjs`.

### Fixed

- `gpu-hub.js` — `POST /beacon` (protocol 2 tick) and `POST /v3/beacon` share
  the heartbeat key `animastor:worker:heartbeat:{type}:{id}` and both rewrote
  it whole, so the v2 tick erased `protocol_version: 3` / `current_job_id`
  left by the v3 tick (reports/2026-11-06 §10). A v2 write now merges those
  two fields from a v3 record younger than the key's 30 s TTL; TTL and every
  other field stay as before. A worker with only the v2 beacon writes the key
  exactly as it did.
