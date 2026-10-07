# Base pinned by digest (a floating `node:20` would re-resolve over time and
# break layer-identity between two builds of the same commit).
FROM node:20@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5

# Set by the release workflow from `git log -1 --format=%ct` so that both the
# image config `created` field and every layer mtime are pinned to the commit
# instead of the wall clock (required for a reproducible index digest).
ARG SOURCE_DATE_EPOCH
# (Fall back to 0 only for ad-hoc local builds without the build-arg: the value
# itself does not matter, only that it is constant for a given commit.)

WORKDIR /app

# Deterministic install: exact versions from package-lock.json. (`npm install`
# without the lock re-resolved semver ranges at build time — not reproducible.)
# --cache /tmp/npm-cache keeps npm's _cacache + _logs (which embed wall-clock
# timestamps in file names and index entries) OUT of the image layer; the dir
# is removed in the same RUN so it never reaches the diff.
# The trailing `find … touch` pins every mtime in this layer to the commit
# (npm writes node_modules with the current time otherwise).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --cache /tmp/npm-cache \
 && rm -rf /tmp/npm-cache \
 && find /app -exec touch -h -d "@${SOURCE_DATE_EPOCH:-0}" {} +

# Runtime code + staged artifacts. artifacts/ is NOT in git: it is produced
# BEFORE the build by scripts/stage-artifacts.cjs from the pins in
# artifacts.lock.json (the release workflow does this). A build without
# staging yields a mount-only image whose artifact routes answer the frozen
# 404 tokens (DEPLOYMENT.md §1).
#
# The release workflow normalizes the mtimes of the build context to
# SOURCE_DATE_EPOCH right before this build (COPY keeps source mtimes).
COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
