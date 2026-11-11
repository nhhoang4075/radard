/**
 * Đăng nhập web: cấu hình (zod), hook Better Auth (mời, nối hồ sơ chủ dự án, fail-closed), middleware
 * 401/403, route `/api/me`, phục vụ file build (SPA fallback). Không gọi mạng: user tạo qua
 * `internalAdapter.createOAuthUser` (đi qua đúng `databaseHooks` như khi GitHub/Google quay về) và phiên
 * qua plugin `testUtils`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  type Database,
  invites,
  profile,
  runMigrations,
  user as userTable,
} from "@radard/db";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { createWebApp } from "../src/web/app.ts";
import { assertMaySignUp, createAuth, ensureProfileForUser } from "../src/web/auth.ts";
import { type AuthConfig, loadAuthConfig } from "../src/web/auth-config.ts";
import { normalizeEmail } from "../src/web/email.ts";
import { addInvite, listInvites, revokeInvite } from "../src/web/invites.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 4 });
const OWNER = "chu.du.an@example.com";
const SECRET = "khoa-thu-nghiem-0123456789-0123456789";

const config = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  secret: SECRET,
  baseURL: "http://localhost:8080",
  ownerEmail: OWNER,
  providers: {},
  ...over,
});

/** Auth có plugin `testUtils` (chỉ test) để dựng phiên mà không qua OAuth thật. */
function makeAuth(over: Partial<AuthConfig> = {}) {
  return createAuth({ db, config: config(over), plugins: [testUtils()] });
}
type TestAuth = ReturnType<typeof makeAuth>;

/** Giống lúc GitHub/Google trả về: tạo user + account qua đường có hook. */
async function oauthSignUp(auth: TestAuth, email: string, opts: { verified?: boolean } = {}) {
  const ctx = await auth.$context;
  const res = await ctx.internalAdapter.createOAuthUser(
    { email, name: `Tên ${email}`, emailVerified: opts.verified ?? true },
    { providerId: "github", accountId: `gh-${email}` },
  );
  return res.user;
}

const profileOf = async (userId: string) =>
  (await db.select().from(profile).where(eq(profile.userId, userId)))[0];
const profileCount = async () => (await db.select().from(profile)).length;

async function cookieHeader(auth: TestAuth, userId: string): Promise<Headers> {
  // `plugins` được nới kiểu ở createAuth nên `ctx.test` không có kiểu; plugin testUtils luôn có mặt ở đây.
  const ctx = (await auth.$context) as unknown as {
    test: { login(o: { userId: string }): Promise<{ headers: Headers }> };
  };
  const { headers } = await ctx.test.login({ userId });
  return headers;
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});
afterAll(async () => {
  await db.$bun.close();
});
beforeEach(async () => {
  await db.execute(
    sql`truncate "user", session, account, verification, invites, profile restart identity cascade`,
  );
});

describe("normalizeEmail", () => {
  test("chữ thường, bỏ khoảng trắng; không phải email thì null", () => {
    expect(normalizeEmail("  Chu.Du.An@Example.COM ")).toBe(OWNER);
    for (const bad of ["", "abc", "@x.com", "a@", "a@@b.com", "a b@c.com", null, 5]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe("loadAuthConfig", () => {
  const base = { secret: SECRET, baseURL: "https://radard.example.com/" };

  test("đủ cấu hình: bỏ dấu / cuối, chuẩn hoá OWNER_EMAIL, chỉ bật provider đủ cặp", () => {
    const { config: c } = loadAuthConfig({
      ...base,
      ownerEmail: " Chu.Du.An@Example.com",
      githubClientId: "id",
      githubClientSecret: "sec",
      googleClientId: "chi-id",
    });
    expect(c?.baseURL).toBe("https://radard.example.com");
    expect(c?.ownerEmail).toBe(OWNER);
    expect(Object.keys(c?.providers ?? {})).toEqual(["github"]);
  });

  test("thiếu hoặc sai secret/URL: trả null (đăng nhập tắt), không ném lỗi", () => {
    expect(loadAuthConfig({ baseURL: base.baseURL }).config).toBeNull();
    expect(loadAuthConfig({ ...base, secret: "ngan" }).config).toBeNull();
    expect(loadAuthConfig({ secret: SECRET }).config).toBeNull();
    expect(loadAuthConfig({ ...base, baseURL: "ftp://x" }).config).toBeNull();
    expect(loadAuthConfig({}).problems.length).toBeGreaterThan(0);
  });

  test("thiếu OWNER_EMAIL: ownerEmail null kèm cảnh báo", () => {
    const r = loadAuthConfig(base);
    expect(r.config?.ownerEmail).toBeNull();
    expect(r.problems.some((p) => p.includes("OWNER_EMAIL"))).toBe(true);
  });
});

describe("assertMaySignUp (trước khi tạo user)", () => {
  test("email không có trong invites bị chặn", async () => {
    await expect(
      assertMaySignUp(db, OWNER, { email: "la@example.com", emailVerified: true }),
    ).rejects.toThrow();
  });

  test("email được mời (khác hoa/thường) được phép; email chưa xác minh thì không", async () => {
    await db.insert(invites).values({ email: "khach@example.com" });
    await assertMaySignUp(db, OWNER, { email: "Khach@Example.com", emailVerified: true });
    await expect(
      assertMaySignUp(db, OWNER, { email: "khach@example.com", emailVerified: false }),
    ).rejects.toThrow();
  });

  test("lời mời đã dùng không dùng lại được", async () => {
    await db.insert(invites).values({ email: "khach@example.com", usedAt: new Date() });
    await expect(
      assertMaySignUp(db, OWNER, { email: "khach@example.com", emailVerified: true }),
    ).rejects.toThrow();
  });

  test("OWNER_EMAIL luôn được phép; thiếu OWNER_EMAIL thì email đó thành người lạ", async () => {
    await assertMaySignUp(db, OWNER, { email: OWNER.toUpperCase(), emailVerified: true });
    await expect(
      assertMaySignUp(db, null, { email: OWNER, emailVerified: true }),
    ).rejects.toThrow();
  });

  test("fail-closed: truy vấn lỗi hoặc không có bảng thì từ chối", async () => {
    const broken = {
      select() {
        throw new Error("boom");
      },
    } as unknown as Database;
    await expect(
      assertMaySignUp(broken, OWNER, { email: "khach@example.com", emailVerified: true }),
    ).rejects.toThrow();

    await db.execute(sql`alter table invites rename to invites_tam`);
    try {
      await expect(
        assertMaySignUp(db, OWNER, { email: "khach@example.com", emailVerified: true }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table invites_tam rename to invites`);
    }
  });

  test("dữ liệu lạ (thiếu email, emailVerified không phải true) bị từ chối", async () => {
    await expect(assertMaySignUp(db, OWNER, {})).rejects.toThrow();
    await expect(
      assertMaySignUp(db, OWNER, { email: OWNER, emailVerified: "true" }),
    ).rejects.toThrow();
  });
});

describe("Better Auth: đăng ký qua hook", () => {
  test("email chưa mời: createOAuthUser bị từ chối, không tạo user nào, không tạo hồ sơ", async () => {
    const auth = makeAuth();
    await expect(oauthSignUp(auth, "la@example.com")).rejects.toThrow();
    expect(await db.select().from(userTable)).toHaveLength(0);
    expect(await profileCount()).toBe(0);
  });

  test("OWNER_EMAIL: nối vào hồ sơ số 1 sẵn có, giữ nguyên dữ liệu, KHÔNG tạo hồ sơ mới", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer", description: "mô tả" });
    const auth = makeAuth();
    const u = await oauthSignUp(auth, "Chu.Du.An@Example.com");
    expect(await profileCount()).toBe(1);
    const p = await profileOf(u.id);
    expect(p).toMatchObject({ id: 1, promptContext: "AI engineer", description: "mô tả" });
  });

  test("người được mời nhận hồ sơ trống mới (id >= 2), lời mời được đánh dấu đã dùng", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    await db.insert(invites).values({ email: "khach@example.com" });
    const auth = makeAuth();
    const u = await oauthSignUp(auth, "khach@example.com");
    expect(await profileCount()).toBe(2);
    const p = await profileOf(u.id);
    expect(p).toMatchObject({ id: 2, promptContext: "", description: null });
    const [inv] = await db.select().from(invites);
    expect(inv?.usedAt).not.toBeNull();
    // Hồ sơ số 1 không bị đụng tới.
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBeNull();
  });

  test("thiếu OWNER_EMAIL: email chủ dự án không vào được, hồ sơ số 1 không bị nối", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    const auth = makeAuth({ ownerEmail: null });
    await expect(oauthSignUp(auth, OWNER)).rejects.toThrow();
    expect((await db.select().from(profile))[0]?.userId).toBeNull();
  });

  test("email chưa xác minh bị từ chối, kể cả khi trùng OWNER_EMAIL", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    const auth = makeAuth();
    await expect(oauthSignUp(auth, OWNER, { verified: false })).rejects.toThrow();
    expect((await db.select().from(profile))[0]?.userId).toBeNull();
  });

  test("DB chưa có hồ sơ số 1: chủ dự án đăng nhập đầu tiên tạo đúng hồ sơ id 1", async () => {
    const auth = makeAuth();
    const u = await oauthSignUp(auth, OWNER);
    expect((await profileOf(u.id))?.id).toBe(1);
  });
});

describe("ensureProfileForUser", () => {
  const mkUser = async (id: string, email: string, invited = true) => {
    await db.insert(userTable).values({ id, name: id, email, emailVerified: true });
    if (invited) await db.insert(invites).values({ email }).onConflictDoNothing();
    return { id, email, emailVerified: true };
  };

  test("thu hồi lời mời: user chưa có hồ sơ mà không còn lời mời thì không nhận hồ sơ mới", async () => {
    const a = await mkUser("u-a", "a@example.com", false); // user có nhưng không có lời mời
    await expect(ensureProfileForUser(db, OWNER, a)).rejects.toThrow();
    expect(await profileCount()).toBe(0);
    await db.insert(invites).values({ email: "a@example.com", usedAt: new Date() }); // đã dùng vẫn đủ
    expect(await ensureProfileForUser(db, OWNER, a)).toBe(2);
  });

  test("session-hook: user bị xoá lời mời và chưa có hồ sơ thì đăng nhập lại bị từ chối", async () => {
    const auth = makeAuth();
    await db.insert(invites).values({ email: "khach@example.com" });
    const u = await oauthSignUp(auth, "khach@example.com");
    await db.delete(profile).where(eq(profile.userId, u.id));
    await db.delete(invites).where(eq(invites.email, "khach@example.com"));
    await expect(cookieHeader(auth, u.id)).rejects.toThrow();
    expect(await profileCount()).toBe(0);
  });

  test("thu hồi: phiên cũ → 401, hồ sơ còn nguyên (user_id NULL); owner không thu hồi được", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    const auth = makeAuth();
    const app = createWebApp({ db, secret: undefined, auth: { auth, providers: [] } }).app;
    await db.insert(invites).values({ email: "khach@example.com" });
    const owner = await oauthSignUp(auth, OWNER);
    const guest = await oauthSignUp(auth, "khach@example.com");
    const guestHeaders = await cookieHeader(auth, guest.id);
    expect((await app.request("/api/me", { headers: guestHeaders })).status).toBe(200);

    // Đã dùng (hook after đánh dấu) nên lời mời không bị xoá, nhưng user thì bị xoá.
    const r = await revokeInvite(db, OWNER, "Khach@Example.com");
    expect(r).toEqual({ email: "khach@example.com", inviteRemoved: false, userRemoved: true });
    expect((await app.request("/api/me", { headers: guestHeaders })).status).toBe(401);
    const guestProfile = (await db.select().from(profile).where(eq(profile.id, 2)))[0];
    expect(guestProfile).toBeDefined();
    expect(guestProfile?.userId).toBeNull();
    // Không đăng nhập lại được: lời mời đã dùng vẫn còn nên có thể đăng ký lại? Không: before-hook đòi chưa dùng.
    await expect(oauthSignUp(auth, "khach@example.com")).rejects.toThrow();

    // Owner: bị chặn, hồ sơ 1 và tài khoản owner không đổi.
    await expect(revokeInvite(db, OWNER, OWNER.toUpperCase())).rejects.toThrow();
    expect((await db.select().from(userTable).where(eq(userTable.id, owner.id))).length).toBe(1);
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBe(owner.id);
  });

  test("revoke lời mời chưa dùng: xoá cả lời mời; add chuẩn hoá chữ thường và idempotent", async () => {
    expect(await addInvite(db, " Moi@Example.com ")).toEqual({
      email: "moi@example.com",
      added: true,
    });
    expect((await addInvite(db, "moi@example.com")).added).toBe(false);
    expect(await listInvites(db)).toHaveLength(1);
    expect(await revokeInvite(db, OWNER, "moi@example.com")).toEqual({
      email: "moi@example.com",
      inviteRemoved: true,
      userRemoved: false,
    });
    expect(await listInvites(db)).toHaveLength(0);
    await expect(addInvite(db, "khong-phai-email")).rejects.toThrow();
  });

  test("không cướp hồ sơ số 1 đã thuộc user khác", async () => {
    const a = await mkUser("u-a", OWNER);
    await db.insert(profile).values({ id: 1, promptContext: "x", userId: a.id });
    await db.execute(sql`update "user" set email = 'khac@example.com' where id = 'u-a'`);
    const b = await mkUser("u-b", "chu.moi@example.com");
    // u-b mang email trùng OWNER_EMAIL mới: hồ sơ 1 đã có chủ → từ chối, không tạo hồ sơ.
    await expect(ensureProfileForUser(db, "chu.moi@example.com", b)).rejects.toThrow();
    expect(await profileCount()).toBe(1);
  });

  test("idempotent: gọi lại trả cùng hồ sơ, không tạo thêm", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "x" });
    const a = await mkUser("u-a", "a@example.com");
    const first = await ensureProfileForUser(db, OWNER, a);
    expect(await ensureProfileForUser(db, OWNER, a)).toBe(first);
    expect(await profileCount()).toBe(2);
  });

  test("chưa xác minh email: ném lỗi, không tạo hồ sơ", async () => {
    await expect(
      ensureProfileForUser(db, OWNER, { id: "u-x", email: OWNER, emailVerified: false }),
    ).rejects.toThrow();
    expect(await profileCount()).toBe(0);
  });

  test("hai người đăng ký đồng thời nhận hai hồ sơ khác nhau", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "x" });
    const [a, b] = await Promise.all([
      mkUser("u-a", "a@example.com"),
      mkUser("u-b", "b@example.com"),
    ]);
    const ids = await Promise.all([
      ensureProfileForUser(db, OWNER, a),
      ensureProfileForUser(db, OWNER, b),
    ]);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => i >= 2)).toBe(true);
  });
});

describe("API: middleware và /api/me", () => {
  const mkApp = (auth: TestAuth | null, webDist?: string) => {
    const w = createWebApp({
      db,
      secret: undefined,
      auth: auth ? { auth, providers: ["github"] } : null,
      webDist,
    });
    return w.app;
  };

  test("chưa có phiên → 401; cookie rác → 401", async () => {
    const app = mkApp(makeAuth());
    expect((await app.request("/api/me")).status).toBe(401);
    const res = await app.request("/api/me", {
      headers: { cookie: "better-auth.session_token=rac" },
    });
    expect(res.status).toBe(401);
  });

  test("route /api chưa khai báo cũng đi qua middleware: chưa đăng nhập 401, đã đăng nhập 404", async () => {
    const auth = makeAuth();
    const app = mkApp(auth);
    expect((await app.request("/api/chua-co")).status).toBe(401);
    await db.insert(invites).values({ email: "khach@example.com" });
    const u = await oauthSignUp(auth, "khach@example.com");
    const res = await app.request("/api/chua-co", { headers: await cookieHeader(auth, u.id) });
    expect(res.status).toBe(404);
  });

  test("có phiên nhưng chưa có hồ sơ → 403", async () => {
    const auth = makeAuth();
    const app = mkApp(auth);
    await db.insert(invites).values({ email: "khach@example.com" });
    const u = await oauthSignUp(auth, "khach@example.com");
    const headers = await cookieHeader(auth, u.id);
    await db.delete(profile).where(eq(profile.userId, u.id)); // hồ sơ biến mất sau khi có phiên
    const res = await app.request("/api/me", { headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_profile" });
  });

  test("có phiên và hồ sơ → 200 với tên và profileId; chủ dự án ra profileId 1", async () => {
    const auth = makeAuth();
    const app = mkApp(auth);
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    await db.insert(invites).values({ email: "khach@example.com" });
    const owner = await oauthSignUp(auth, OWNER);
    const guest = await oauthSignUp(auth, "khach@example.com");

    const r1 = await app.request("/api/me", { headers: await cookieHeader(auth, owner.id) });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ name: `Tên ${OWNER}`, profileId: 1 });
    const r2 = await app.request("/api/me", { headers: await cookieHeader(auth, guest.id) });
    expect(await r2.json()).toEqual({ name: "Tên khach@example.com", profileId: 2 });
  });

  test("lưới an toàn: user mất hồ sơ ở bước 'after' thì đăng nhập lần sau nối lại, không cấp phiên khi không nối được", async () => {
    const auth = makeAuth();
    await db.insert(invites).values({ email: "khach@example.com" });
    const u = await oauthSignUp(auth, "khach@example.com");
    await db.delete(profile).where(eq(profile.userId, u.id));
    await db.execute(sql`update invites set used_at = null`);
    await cookieHeader(auth, u.id); // tạo phiên → hook session nối lại
    expect(await profileOf(u.id)).toBeDefined();
    // Email không xác minh: không nối được thì không có phiên.
    await db.delete(profile).where(eq(profile.userId, u.id));
    await db.execute(sql`update "user" set email_verified = false where id = ${u.id}`);
    await expect(cookieHeader(auth, u.id)).rejects.toThrow();
  });

  test("/api/providers công khai; không cấu hình đăng nhập thì /api/* trả 503, /healthz vẫn 200", async () => {
    const withAuth = mkApp(makeAuth());
    const res = await withAuth.request("/api/providers");
    expect(await res.json()).toEqual({ providers: ["github"] });

    const without = mkApp(null);
    expect((await without.request("/api/me")).status).toBe(503);
    expect((await without.request("/api/auth/get-session")).status).toBe(503);
    expect((await without.request("/healthz")).status).toBe(200);
  });

  test("Better Auth đã gắn: /api/auth/get-session không phiên trả null", async () => {
    const app = mkApp(makeAuth());
    const res = await app.request("/api/auth/get-session");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe("phục vụ file build", () => {
  const dist = mkdtempSync(join(tmpdir(), "radard-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>radard</title>");
  writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)");
  const app = createWebApp({ db, secret: undefined, webDist: dist }).app;

  test("/ và đường dẫn của router trả index.html (SPA fallback)", async () => {
    for (const path of ["/", "/login", "/a/b/c"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>radard</title>");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  test("asset có cache dài; file có đuôi mà không tồn tại thì 404, không fallback", async () => {
    const asset = await app.request("/assets/app-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/assets/khong-co.js")).status).toBe(404);
  });

  test("không thoát khỏi thư mục build", async () => {
    for (const path of [
      "/..%2f..%2fpackage.json",
      "/%2e%2e/%2e%2e/package.json",
      "/assets/..%2f..%2fx.json",
    ]) {
      const res = await app.request(path);
      expect(res.status === 404 || (await res.text()).includes("<title>radard</title>")).toBe(true);
    }
  });

  test("thư mục build thiếu: 404 trơn; route cũ không đổi", async () => {
    const empty = createWebApp({ db, secret: undefined, webDist: join(dist, "khong-co") }).app;
    expect((await empty.request("/")).status).toBe(404);
    expect((await empty.request("/healthz")).status).toBe(200);
    expect((await empty.request("/o/rac")).status).toBe(404);
  });

  test("phương thức không phải GET/HEAD tới đường dẫn lạ: 404", async () => {
    expect((await app.request("/login", { method: "POST" })).status).toBe(404);
  });
});
