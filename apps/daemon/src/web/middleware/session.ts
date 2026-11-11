/**
 * Middleware phiên (fail-closed): đọc phiên Better Auth, tra hồ sơ theo `profile.user_id`, đặt
 * `c.set("profileId")`. Chưa có phiên (hoặc lỗi không xác định được người dùng) → 401; có phiên nhưng
 * chưa có hồ sơ → 403. Mọi route dưới `routes/` (trừ `link.ts`) phải mount SAU middleware này; test
 * `web-routes-rule.test.ts` giữ luật đó. Hàm xử lý chỉ đọc `profileId` từ context, không từ request.
 */
import { createLogger } from "@radard/core";
import { type Database, profile } from "@radard/db";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Auth } from "../auth.ts";

const log = createLogger("web:session");

export interface SessionEnv {
  Variables: {
    profileId: number;
    userId: string;
    userName: string;
    userEmail: string;
    emailVerified: boolean;
  };
}

export const sessionMiddleware = (deps: { db: Database; auth: Auth }) =>
  createMiddleware<SessionEnv>(async (c, next) => {
    let session: Awaited<ReturnType<Auth["api"]["getSession"]>>;
    let row: { id: number } | undefined;
    try {
      session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: "unauthenticated" }, 401);
      [row] = await deps.db
        .select({ id: profile.id })
        .from(profile)
        .where(eq(profile.userId, session.user.id))
        .limit(1);
    } catch (err) {
      // Không xác định được người dùng thì không cho qua.
      log.error("đọc phiên lỗi", { err: err instanceof Error ? err.name : "unknown" });
      return c.json({ error: "unauthenticated" }, 401);
    }
    if (!row) return c.json({ error: "no_profile" }, 403);
    c.set("profileId", row.id);
    c.set("userId", session.user.id);
    c.set("userName", session.user.name);
    c.set("userEmail", session.user.email);
    c.set("emailVerified", session.user.emailVerified === true);
    await next();
  });
