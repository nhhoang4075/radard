/** Vai trò `web`: mở cổng HTTP phục vụ `/healthz` và `/o/:token`. */
import { createLogger } from "@radard/core";
import type { Database } from "@radard/db";
import { createWebApp } from "../web/app.ts";

const log = createLogger("web");

export function startWeb(opts: {
  db: Database;
  port: number;
  secret: string | undefined;
}): () => Promise<void> {
  if (!opts.secret) log.warn("chưa đặt LINK_SECRET: route /o/* trả 404 cho mọi token");
  const { app, idle } = createWebApp({ db: opts.db, secret: opts.secret });
  const server = Bun.serve({ port: opts.port, fetch: app.fetch });
  log.info("web đang nghe", { port: server.port });
  return async () => {
    await server.stop();
    await idle();
  };
}
