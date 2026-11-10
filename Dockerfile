# Một image cho mọi vai trò của daemon, chọn bằng SERVICE_ROLE (mặc định all).
# Bun chạy thẳng TypeScript nên daemon không có bước build. Riêng giao diện web (apps/web, React + Vite)
# được build ở stage đầu, rồi chép thư mục dist sang image chạy để vai trò `web` phục vụ cùng origin.

# --- Stage 1: build giao diện web. Cần devDependencies (vite, react…); stage này không vào image cuối. ---
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

# --- Stage 2: image chạy. ---
FROM oven/bun:1.4.3-slim

WORKDIR /app
ENV NODE_ENV=production

# Cài phụ thuộc trước, chép code sau: sửa code không phải cài lại. `apps/web/package.json` vẫn cần
# để lockfile khớp; web chỉ có devDependencies nên `--production` không cài gì cho nó.
COPY package.json bun.lock ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/
COPY packages/adapters/package.json packages/adapters/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production

# Image oven/bun có sẵn user `bun`; không chạy bằng root. `--chown` vì file trên máy có thể chỉ
# chủ sở hữu đọc được (quyền 600), chép nguyên quyền thì user `bun` không đọc nổi.
COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun packages packages
COPY --chown=bun:bun apps/daemon apps/daemon
COPY --from=web-build --chown=bun:bun /app/apps/web/dist apps/web/dist
USER bun
CMD ["bun", "apps/daemon/src/main.ts"]
