/**
 * Luật giữ bằng máy (docs/cau-truc-web.html mục 6): mọi route dưới `/api` (trừ `/api/auth/*`, route công
 * khai `providers`, và `/o/:token`) phải đi qua middleware phiên. Lưới an toàn chống quên kiểm phiên:
 * liệt kê TOÀN BỘ route Hono đã đăng ký, gọi từng cái không kèm phiên và đòi 401.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@radard/db";
import { Hono } from "hono";
import { createWebApp } from "../src/web/app.ts";
import { createAuth } from "../src/web/auth.ts";
import { ownerOnly } from "../src/web/middleware/owner-only.ts";
import type { SessionEnv } from "../src/web/middleware/session.ts";

const db = createDatabase(
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test",
  {
    max: 1,
  },
);
const auth = createAuth({
  db,
  config: {
    secret: "khoa-thu-nghiem-0123456789-0123456789",
    baseURL: "http://localhost:8080",
    ownerEmail: null,
    providers: {},
  },
});
const PUBLIC = [/^\/healthz$/, /^\/o\/:token$/, /^\/api\/auth\//, /^\/api\/providers$/];

describe("luật: route /api đi qua middleware phiên", () => {
  const { app } = createWebApp({ db, secret: undefined, auth: { auth, providers: [] } });

  test("mọi route đã đăng ký dưới /api, ngoài danh sách công khai, trả 401 khi chưa có phiên", async () => {
    const routes = app.routes.filter(
      (r) => r.method !== "ALL" && r.path.startsWith("/api") && !PUBLIC.some((p) => p.test(r.path)),
    );
    expect(routes.length).toBeGreaterThan(0); // ít nhất /api/me
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, "1");
      const res = await app.request(path, { method: r.method });
      expect(`${r.method} ${r.path} → ${res.status}`).toBe(`${r.method} ${r.path} → 401`);
    }
  });

  test("đường dẫn /api bất kỳ chưa khai báo cũng 401 khi chưa có phiên (không lộ route nào tồn tại)", async () => {
    for (const p of ["/api/feed", "/api/sources", "/api/x/y/z"]) {
      expect((await app.request(p)).status).toBe(401);
    }
  });

  test("quét mã: file trong routes/ (trừ link.ts) không tự đăng ký đường dẫn tuyệt đối /api hay bỏ qua middleware", () => {
    const dir = join(import.meta.dir, "../src/web/routes");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "link.ts")) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/["'`]\/api\//); // đường dẫn tương đối, do app.ts mount
      expect(src).not.toMatch(/\.on\(\s*\[/); // không đăng ký nhiều method kiểu tự do
    }
    // app.ts: sessionMiddleware phải đứng trước mọi `.route(` của routes/.
    const appSrc = readFileSync(join(import.meta.dir, "../src/web/app.ts"), "utf8");
    const use = appSrc.indexOf('.use("*", sessionMiddleware(');
    expect(use).toBeGreaterThan(0);
    for (const m of appSrc.matchAll(/\.route\("\/(?!api)[^"]*",/g)) {
      expect(m.index).toBeGreaterThan(use);
    }
  });
});

describe("ownerOnly", () => {
  const mk = (ownerEmail: string | null, email: string, verified: boolean) => {
    const app = new Hono<SessionEnv>();
    app.use("*", async (c, next) => {
      c.set("userEmail", email);
      c.set("emailVerified", verified);
      await next();
    });
    app.use("*", ownerOnly(ownerEmail));
    app.get("/x", (c) => c.text("ok"));
    return app;
  };
  test("chỉ email chủ đã xác minh qua; thiếu OWNER_EMAIL thì không ai qua", async () => {
    expect((await mk("a@x.com", "A@X.com", true).request("/x")).status).toBe(200);
    expect((await mk("a@x.com", "b@x.com", true).request("/x")).status).toBe(403);
    expect((await mk("a@x.com", "a@x.com", false).request("/x")).status).toBe(403);
    expect((await mk(null, "a@x.com", true).request("/x")).status).toBe(403);
  });
});
