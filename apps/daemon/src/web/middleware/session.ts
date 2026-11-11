/**
 * Session middleware (fail-closed): reads the Better Auth session, looks up the profile by `profile.user_id`, sets
 * `c.set("profileId")`. No session (or a user that cannot be identified) → 401; a session with no
 * profile → 403. Every route under `routes/` (except `link.ts`) must be mounted AFTER this middleware; the test
 * `web-routes-rule.test.ts` enforces that rule. Handlers read `profileId` only from the context, never from the request.
 */
import { createLogger } from "@radard/core";
import { type Database, profile, userRoles } from "@radard/db";
import { and, eq } from "drizzle-orm";
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
    /** Has a `user_roles` row with role `owner`, looked up in the DB on every request (not cached in the session). */
    isOwner: boolean;
  };
}

export const sessionMiddleware = (deps: { db: Database; auth: Auth }) =>
  createMiddleware<SessionEnv>(async (c, next) => {
    let session: Awaited<ReturnType<Auth["api"]["getSession"]>>;
    let row: { id: number } | undefined;
    let isOwner = false;
    try {
      session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: "unauthenticated" }, 401);
      [row] = await deps.db
        .select({ id: profile.id })
        .from(profile)
        .where(eq(profile.userId, session.user.id))
        .limit(1);
      const [role] = await deps.db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(and(eq(userRoles.userId, session.user.id), eq(userRoles.role, "owner")))
        .limit(1);
      isOwner = role !== undefined;
    } catch (err) {
      // If the user cannot be identified, do not let the request through.
      log.error("đọc phiên lỗi", { err: err instanceof Error ? err.name : "unknown" });
      return c.json({ error: "unauthenticated" }, 401);
    }
    if (!row) return c.json({ error: "no_profile" }, 403);
    c.set("profileId", row.id);
    c.set("userId", session.user.id);
    c.set("userName", session.user.name);
    c.set("userEmail", session.user.email);
    c.set("emailVerified", session.user.emailVerified === true);
    c.set("isOwner", isOwner);
    await next();
  });
