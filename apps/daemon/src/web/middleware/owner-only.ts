/**
 * Chỉ chủ dự án (route Nguồn, Engine). Đặt SAU `sessionMiddleware`. Chủ dự án = email đã xác minh của
 * phiên trùng `OWNER_EMAIL` (sau chuẩn hoá chữ thường). Thiếu `OWNER_EMAIL` thì không ai là chủ (403).
 */
import { createMiddleware } from "hono/factory";
import { normalizeEmail } from "../email.ts";
import type { SessionEnv } from "./session.ts";

export const ownerOnly = (ownerEmail: string | null) =>
  createMiddleware<SessionEnv>(async (c, next) => {
    const email = normalizeEmail(c.get("userEmail"));
    if (!ownerEmail || !email || email !== ownerEmail || c.get("emailVerified") !== true) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
