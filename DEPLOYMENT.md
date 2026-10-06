# DEPLOYMENT.md — external deployment contract (artifact mounts + seams)

`@animastor/gpu-hub` is a self-contained service, but five of its HTTP routes serve
**onboarding artifacts that are NOT part of this repository**. The hub performs zero
filesystem writes; the artifacts must be mounted read-only into the container by the
deployment. This is a deliberate external deployment contract (Phase 10H): it is
recorded here as-is and is NOT re-architected in this phase.

## 1. Required read-only artifact mounts

| # | Container path (frozen) | Serves route | Source in the Animastor monorepo (reference deployment) |
|---|---|---|---|
| 1 | `/app/worker-source/worker.cjs` | `GET /worker-source` (deprecated, backward compat) | `worker/worker/worker.cjs` |
| 2 | `/app/worker-bundle` | `GET /worker-bundle`, `GET /worker-bundle/sha256` | `worker/worker/` (bundle version = `package.json` inside this dir) |
| 3 | `/app/workflows` | `GET /workflow/:id` (allowlist from manifests) | `backend/ai/workflows/` |
| 4 | `/app/installer-src` | `GET /installer`, `/installer/bundle`, `/installer/sha256` | `backend/src/installer/` (installer version = `package.json` inside this dir) |
| 5 | `/app/install-manifests` | allowlist input for `/workflow/:id` and `/installer` profiles | `backend/ai/install-manifests/` |

All five mounts are **read-only** (`:ro`). Missing mounts do not crash the hub — the
corresponding artifact routes answer the frozen 404 tokens
(`worker_source_unavailable`, `worker_bundle_unavailable`, `installer_unavailable`,
`workflow_not_found` / `workflow_unavailable`).

Optional sixth mount: `/app/installer-pkg` — the canonical installer package root
(its `package.json` is the installer version source when the flat
`/app/installer-src` mount carries no `package.json`). This exists because a file
bind-mount nested inside the read-only `/app/installer-src` dir mount is rejected
by runc.

### Artifact directory resolution order (normative)

`resolveArtifactDir()` (gpu-hub.js) picks each artifact directory in this order:

1. **explicit env/config override** (`WORKER_BUNDLE_DIR`, `WORKFLOW_DIR`,
   `INSTALLER_SRC_DIR`, `INSTALLER_MANIFESTS_DIR`, `INSTALLER_WORKFLOWS_DIR`,
   `INSTALLER_PKG_DIR`) — forwarded from the environment by `server.js`; must be a
   readable directory, otherwise **startup fails with an explicit error** (never a
   silent fallback);
2. **live bind mount** at the frozen `/app/...` target — a mounted local source
   always beats baked-in artifacts (a local mount is never silently ignored);
3. **baked-in** `/app/artifacts/<name>` — only when nothing is mounted (images
   built with artifact bake-in keep working standalone);
4. the frozen mount target — routes answer the frozen 404 tokens, never a stale
   baked-in artifact.

The mount TARGETS (`/app/...`) are `[NORMATIVE — FROZEN]`
(`docs/architecture/GPU_HUB_CONTRACT.md` §12 in the monorepo). A deployment may take
the SOURCES from any external location as long as shapes match:

- `/app/worker-source/worker.cjs` — single self-contained worker file (secret-free).
- `/app/worker-bundle/` — worker runtime tree with canonical `package.json`
  (`animastor-worker`); `.env` / `.env.*` (except `.env.example`) are never served.
- `/app/workflows/` — baseline workflow JSON files.
- `/app/installer-src/` — installer package tree with canonical `package.json`.
- `/app/install-manifests/` — `**/*.json` install manifests
  (workflows allowlist + profile allowlist are derived from them).

## 2. Reference compose fragment (standalone deployment)

```yaml
services:
  gpu-hub:
    build: .
    container_name: gpu-hub
    networks: [net]
    environment:
      - REDIS_URL=redis://animastor-redis:6379
      - BACKEND_URL=http://animastor-backend:3000
      - GPU_HUB_API_KEY=${GPU_HUB_API_KEY:?must match the backend value}
      - GPU_TIMEOUT=${GPU_TIMEOUT:-600000}
      - SHARE_FEATURES_ENABLED=${SHARE_FEATURES_ENABLED:-0}
    volumes:
      - <worker-runtime>/worker.cjs:/app/worker-source/worker.cjs:ro
      - <worker-runtime>:            /app/worker-bundle:ro
      - <backend-workflows>:         /app/workflows:ro
      - <installer-src>:             /app/installer-src:ro
      - <install-manifests>:         /app/install-manifests:ro
      # optional — canonical installer version when <installer-src> has no
      # package.json (replaces the impossible nested file mount):
      - <installer-package-root>:    /app/installer-pkg:ro
```

## 3. Other deployment seams (unchanged, frozen)

| Seam | Contract |
|---|---|
| Internal DNS | `http://gpu-hub:5000` on the compose network; nginx routes `/gpu/` → hub `:5000` (public path = same path under `/gpu/`) |
| Env vars | `PORT`, `REDIS_URL`, `BACKEND_URL`, `GPU_HUB_API_KEY`, `GPU_HUB_ALLOW_OPEN` (dev-only), `GPU_TIMEOUT_MS`/`GPU_TIMEOUT`, `SHARE_FEATURES_ENABLED`, `ORPHAN_GRACE_MS`, `MAX_ORPHAN_REQUEUES`, artifact dir overrides (`WORKER_BUNDLE_DIR`, `WORKFLOW_DIR`, `INSTALLER_SRC_DIR`, `INSTALLER_MANIFESTS_DIR`, `INSTALLER_WORKFLOWS_DIR`, `INSTALLER_PKG_DIR`) |
| Redis | single `REDIS_URL` instance; hub-owned key families (`animastor:gpu-hub:workers`, queue/running/heartbeat/dead-letter); reads (never writes) the backend-owned `animastor:worker-auth` mirror |
| Backend callbacks | `POST ${BACKEND_URL}/gpu/task/result` and `/gpu/task/error` (Job Protocol v2 envelopes, 5 retries × 500 ms, error fallback key TTL 1 h) |
| Public exposure | never expose the hub directly to the internet; always behind the authenticated nginx `/gpu/` prefix + `GPU_HUB_API_KEY` |
