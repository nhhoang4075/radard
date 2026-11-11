/**
 * Owners only (the Sources and Engine routes). Mounted AFTER `sessionMiddleware`, relies on `isOwner` (a `user_roles` row with
 * role `owner`, looked up in the DB on every request). Does not compare emails or read environment variables. Non-owners get 403.
 */
import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "./session.ts";

export const ownerOnly = () =>
  createMiddleware<SessionEnv>(async (c, next) => {
    if (c.get("isOwner") !== true) return c.json({ error: "forbidden" }, 403);
    await next();
  });
