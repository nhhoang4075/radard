/**
 * Machine-enforced rule (docs/cau-truc-web.html section 6): every route under `/api` (except `/api/auth/*`, the public route
 * that declares `providers`, and `/o/:token`) must pass through the session middleware. Safety net against forgetting session checks:
 * list ALL registered Hono routes, call each one without a session, and expect 401.
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
    bootstrapOwnerEmails: [],
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
    expect(routes.length).toBeGreaterThan(0); // at least /api/me
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
      expect(src).not.toMatch(/["'`]\/api\//); // relative paths, mounted by app.ts
      expect(src).not.toMatch(/\.on\(\s*\[/); // no free-form multi-method registration
    }
    // app.ts: sessionMiddleware must come before every `.route(` of routes/.
    const appSrc = readFileSync(join(import.meta.dir, "../src/web/app.ts"), "utf8");
    const use = appSrc.indexOf('.use("*", sessionMiddleware(');
    expect(use).toBeGreaterThan(0);
    for (const m of appSrc.matchAll(/\.route\("\/(?!api)[^"]*",/g)) {
      expect(m.index).toBeGreaterThan(use);
    }
  });
});

describe("ownerOnly", () => {
  const mk = (isOwner: boolean, email = "a@x.com") => {
    const app = new Hono<SessionEnv>();
    app.use("*", async (c, next) => {
      c.set("userEmail", email);
      c.set("emailVerified", true);
      c.set("isOwner", isOwner);
      await next();
    });
    app.use("*", ownerOnly());
    app.get("/x", (c) => c.text("ok"));
    return app;
  };
  test("chỉ isOwner qua; email không quyết định gì", async () => {
    expect((await mk(true).request("/x")).status).toBe(200);
    expect((await mk(false).request("/x")).status).toBe(403);
    expect((await mk(false, "chu@x.com").request("/x")).status).toBe(403);
  });
});
