/** Vai trò `web`: mở cổng HTTP phục vụ `/healthz`, `/o/:token`, `/api/*` (đăng nhập) và file build của `apps/web`. */
import { createLogger } from "@radard/core";
import type { Database } from "@radard/db";
import { createWebApp } from "../web/app.ts";
import { createAuth } from "../web/auth.ts";
import { loadAuthConfig, type RawAuthEnv, type SocialProviderId } from "../web/auth-config.ts";

const log = createLogger("web");

export function startWeb(opts: {
  db: Database;
  port: number;
  secret: string | undefined;
  auth: RawAuthEnv;
}): () => Promise<void> {
  if (!opts.secret) log.warn("chưa đặt LINK_SECRET: route /o/* trả 404 cho mọi token");
  const { config, problems } = loadAuthConfig(opts.auth);
  for (const p of problems) log.warn(`đăng nhập: ${p}`);
  if (!config) log.warn("đăng nhập tắt: mọi /api/* trả 503 cho tới khi cấu hình đủ");
  const auth = config
    ? {
        auth: createAuth({ db: opts.db, config }),
        providers: Object.keys(config.providers) as SocialProviderId[],
      }
    : null;
  const { app, idle } = createWebApp({ db: opts.db, secret: opts.secret, auth });
  const server = Bun.serve({ port: opts.port, fetch: app.fetch });
  log.info("web đang nghe", { port: server.port });
  return async () => {
    await server.stop();
    await idle();
  };
}
