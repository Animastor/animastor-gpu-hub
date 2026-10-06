FROM node:20

WORKDIR /app

# Deterministic install: exact versions from package-lock.json. (`npm install`
# without the lock re-resolved semver ranges at build time — not reproducible.)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Runtime code + staged artifacts. artifacts/ is NOT in git: it is produced
# BEFORE the build by scripts/stage-artifacts.cjs from the pins in
# artifacts.lock.json (the release workflow does this). A build without
# staging yields a mount-only image whose artifact routes answer the frozen
# 404 tokens (DEPLOYMENT.md §1).
COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
