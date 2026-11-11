# One image for every daemon role, chosen with SERVICE_ROLE (default: all).
# Bun runs TypeScript directly, so the daemon has no build step. Only the web UI (apps/web, React + Vite)
# is built in the first stage; its dist folder is copied into the runtime image so the `web` role serves it from the same origin.

# --- Stage 1: build the web UI. Needs devDependencies (vite, react...); this stage does not reach the final image. ---
FROM oven/bun:1.4.3-slim AS web-build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
COPY packages/adapters/package.json packages/adapters/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/daemon apps/daemon
COPY apps/web apps/web
RUN bun run --cwd apps/web build

# --- Stage 2: runtime image. ---
FROM oven/bun:1.4.3-slim

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies before copying code, so code edits do not trigger a reinstall. `apps/web/package.json` is still needed
# so the lockfile matches; web has only devDependencies, so `--production` installs nothing for it.
COPY package.json bun.lock ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
COPY packages/adapters/package.json packages/adapters/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production

# The oven/bun image ships a `bun` user; do not run as root. `--chown` because local files may be readable only by
# their owner (mode 600); copying the mode as is would leave the `bun` user unable to read them.
COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun packages packages
COPY --chown=bun:bun apps/daemon apps/daemon
COPY --from=web-build --chown=bun:bun /app/apps/web/dist apps/web/dist
USER bun
CMD ["bun", "apps/daemon/src/main.ts"]
