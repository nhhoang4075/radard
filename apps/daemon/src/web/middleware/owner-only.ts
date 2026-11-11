/**
 * Chỉ owner (route Nguồn, Engine). Đặt SAU `sessionMiddleware`, dựa vào `isOwner` (dòng `user_roles` role
 * `owner`, tra DB mỗi request). Không so email, không đọc biến môi trường. Không phải owner thì 403.
 */
import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "./session.ts";

export const ownerOnly = () =>
  createMiddleware<SessionEnv>(async (c, next) => {
    if (c.get("isOwner") !== true) return c.json({ error: "forbidden" }, 403);
    await next();
  });
