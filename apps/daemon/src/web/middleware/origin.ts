/**
 * Chống CSRF lớp hai (cookie đã SameSite=Lax): với method không an toàn (POST/PUT/PATCH/DELETE), có
 * header `Origin` mà khác origin của `BETTER_AUTH_URL` thì 403. Không có `Origin` (sendBeacon cùng
 * origin đôi khi vắng) thì cho qua; `Origin: null` (iframe sandbox…) là có Origin và khác nên bị chặn.
 */
import { createMiddleware } from "hono/factory";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const originGuard = (baseURL: string) => {
  const allowed = new URL(baseURL).origin;
  return createMiddleware(async (c, next) => {
    if (!SAFE.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== allowed) return c.json({ error: "bad_origin" }, 403);
    }
    await next();
  });
};
