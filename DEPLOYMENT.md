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

## 4. Reproducible release build (post-split artifact sources)

Release images are built by `.github/workflows/ghcr-release.yml` from
**pinned sources only** — never from a floating branch and never from a local
checkout of another repository. `artifacts.lock.json` pins each group to an
immutable `{repository, commit}` plus its `version` and `sha256_tree`:

| # | Artifact group | Canonical source (post-split) |
|---|---|---|
| 1 | `worker-bundle` | `Animastor/animastor-worker` @ pinned commit → `packages/animastor-worker/worker` (version = its `package.json`) |
| 2 | `workflows` | `Animastor/animastor-backend` @ pinned commit → `backend/ai/workflows` |
| 3 | `installer-src` | `Animastor/animastor-backend` @ pinned commit → `packages/animastor-installer/src/installer` + root `package.json` (flattened, version = `0.1.0`) |
| 4 | `install-manifests` | `Animastor/animastor-backend` @ pinned commit → `packages/animastor-installer/ai/install-manifests` |

Pipeline: `scripts/stage-artifacts.cjs` verifies every source checkout is AT
the pinned commit, stages a fresh `artifacts/`, and recomputes each
`sha256_tree` — **any mismatch exits non-zero and the release FAILS**, so a
stale or missing artifact can never be baked in silently → reproducible
`docker buildx build` (`npm ci` from `package-lock.json`) → smoke tests, including
`scripts/smoke-artifacts.cjs`, which asserts the RUNNING hub serves exactly
the locked versions/bytes → push → the immutable digest **and** the content
digest (`scripts/content-hash.cjs`, `<files> <sha256>` of `/app`) are recorded.

`artifacts/` and `_sources/` are staging-only and gitignored: the pins plus
verification are the contract, not the bytes. Bumping a pin is a reviewed
commit produced by
`node scripts/stage-artifacts.cjs --write-lock --worker <checkout> --backend <checkout>`.

Reproducibility is asserted on two levels:

1. **Content** (cross-environment): two independent clean builds must produce
   the same content digest from `scripts/content-hash.cjs`
   (`<files> <sha256>` of `/app`) — this is the value recorded in the CI
   step summary.
2. **Index digest** (same commit ⇒ same digest): the release build is
   bit-reproducible end to end. The workflow pins all of it:
   - the base image is pinned by digest in `Dockerfile` (`node:20@sha256:…`),
     so the base layers cannot drift with the floating tag;
   - every build-context mtime is set to `git log -1 --format=%ct` before
     the build, because `COPY` copies source mtimes into the layer;
   - `SOURCE_DATE_EPOCH` (= that commit time) pins the image config
     `created` field and drives `rewrite-timestamp=true` on the
     `type=docker` tar output, which rewrites layer tar mtimes (including
     the `/app` directory mtime `COPY` writes at build time) — required
     because `rewrite-timestamp` conflicts with the daemon's `unpack` mode,
     so the image is exported to a tar and `docker load`ed instead of
     `--load`ed directly;
   - `--provenance=false` drops the BuildKit attestation manifest, which
     embeds the tag name and wall-clock build time and would otherwise
     change the pushed index digest even for bit-identical layers;
   - `npm ci` uses a cache dir removed in the same `RUN` (npm's `_cacache`
     and `_logs` embed wall-clock timestamps) and every mtime it creates is
     touched to `SOURCE_DATE_EPOCH`;
   - the daemon runs the containerd image store on GH-hosted runners (the
     same store the local reproducibility proofs and the load/push path use;
     it is also what makes the `type=docker` exporter legal for the plain
     docker driver);
   - the BuildKit engine is pinned on both sides — CI creates a
     docker-container builder from
     `moby/buildkit:v0.27.1@sha256:1e110c71…` (the version the local proofs
     ran with): different BuildKit versions serialize image history
     differently (`EXPOSE` renders as `map[5000/tcp:{}]` vs
     `[5000/tcp]`), which changes the config digest even for bit-identical
     layers;
   - every build-context file mode is normalized to 0644/0755 before the
     build: the host umask leaks into checkout file modes (0664/0771 with
     umask 0002 vs 0644/0755 with umask 022) and `COPY` preserves them, so
     without this the same bytes land in different layer tars on different
     machines (verified byte-level — mode was the only content difference
     in the COPY layers); no tracked file carries an exec bit, so the
     normalization is lossless for the image.

   Two independent `--no-cache` builds of one commit have been verified to
   produce identical layer `diff_id`s, an identical config digest and an
   identical pushed registry digest.
