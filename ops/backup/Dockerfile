# Sao lưu Postgres lên R2 (chạy bằng Railway Cron, xem backup.ts). Cần pg_dump đúng bản 18 (khớp server
# Postgres 18 trên Railway; pg_dump cũ hơn server sẽ từ chối) và Bun để tải lên R2.
# Build từ gốc repo: RAILWAY_DOCKERFILE_PATH=ops/backup/Dockerfile.
FROM postgres:18
COPY --from=oven/bun:1.4.3-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY ops/backup/backup.ts ./
USER postgres
ENTRYPOINT []
CMD ["bun", "backup.ts"]
