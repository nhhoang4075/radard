/**
 * Second-layer CSRF protection (cookies are already SameSite=Lax): for unsafe methods (POST/PUT/PATCH/DELETE), if there is an
 * `Origin` header that differs from the origin of `BETTER_AUTH_URL`, return 403. With no `Origin` (sendBeacon from the same
 * origin is sometimes missing) the request is let through; `Origin: null` (sandboxed iframe…) does have an Origin and differs, so it is blocked.
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
