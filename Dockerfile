# Một image cho mọi vai trò của daemon, chọn bằng SERVICE_ROLE (mặc định all).
# Bun chạy thẳng TypeScript nên không có bước build; chỉ cài phụ thuộc chạy, không cài devDependencies.
FROM oven/bun:1.4.3-slim

WORKDIR /app
ENV NODE_ENV=production

# Cài phụ thuộc trước, chép code sau: sửa code không phải cài lại.
COPY package.json bun.lock ./
COPY apps/daemon/package.json apps/daemon/
COPY packages/adapters/package.json packages/adapters/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production

# Image oven/bun có sẵn user `bun`; không chạy bằng root. `--chown` vì file trên máy có thể chỉ
# chủ sở hữu đọc được (quyền 600), chép nguyên quyền thì user `bun` không đọc nổi.
COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun packages packages
COPY --chown=bun:bun apps apps
USER bun
CMD ["bun", "apps/daemon/src/main.ts"]
