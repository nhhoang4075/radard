# Postgres backup to R2 (run by Railway Cron, see backup.ts). Needs pg_dump 18 exactly (matches the server
# Postgres 18 on Railway; an older pg_dump refuses a newer server) and Bun to upload to R2.
# Build from the repo root: RAILWAY_DOCKERFILE_PATH=ops/backup/Dockerfile.
FROM postgres:18
COPY --from=oven/bun:1.4.3-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY ops/backup/backup.ts ./
USER postgres
ENTRYPOINT []
CMD ["bun", "backup.ts"]
