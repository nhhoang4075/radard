/**
 * Web sign-in: config (zod), Better Auth hooks (invites, linking the project owner's profile, fail-closed), middleware
 * 401/403, route `/api/me`, serving the build files (SPA fallback). No network calls: users are created via
 * `internalAdapter.createOAuthUser` (going through the same `databaseHooks` as when GitHub/Google redirect back), and the session
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
  userRoles,
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
  bootstrapOwnerEmails: [OWNER],
  providers: {},
  ...over,
});

/** Auth has a `testUtils` plugin (tests only) to build a session without real OAuth. */
function makeAuth(over: Partial<AuthConfig> = {}) {
  return createAuth({ db, config: config(over), plugins: [testUtils()] });
}
type TestAuth = ReturnType<typeof makeAuth>;

/** Same as when GitHub/Google return: creates user + account through the hooked path. */
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
  // `plugins` is loosened in createAuth, so `ctx.test` has no type; the testUtils plugin is always present here.
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

  test("đủ cấu hình: bỏ dấu / cuối, chuẩn hoá BOOTSTRAP_OWNER_EMAILS, chỉ bật provider đủ cặp", () => {
    const { config: c } = loadAuthConfig({
      ...base,
      bootstrapOwnerEmails: " Chu.Du.An@Example.com, ,b@example.com,chu.du.an@example.com,sai",
      githubClientId: "id",
      githubClientSecret: "sec",
      googleClientId: "chi-id",
    });
    expect(c?.baseURL).toBe("https://radard.example.com");
    expect(c?.bootstrapOwnerEmails).toEqual([OWNER, "b@example.com"]);
    expect(Object.keys(c?.providers ?? {})).toEqual(["github"]);
  });

  test("thiếu hoặc sai secret/URL: trả null (đăng nhập tắt), không ném lỗi", () => {
    expect(loadAuthConfig({ baseURL: base.baseURL }).config).toBeNull();
    expect(loadAuthConfig({ ...base, secret: "ngan" }).config).toBeNull();
    expect(loadAuthConfig({ secret: SECRET }).config).toBeNull();
    expect(loadAuthConfig({ ...base, baseURL: "ftp://x" }).config).toBeNull();
    expect(loadAuthConfig({}).problems.length).toBeGreaterThan(0);
  });

  test("thiếu BOOTSTRAP_OWNER_EMAILS: danh sách rỗng kèm cảnh báo", () => {
    const r = loadAuthConfig(base);
    expect(r.config?.bootstrapOwnerEmails).toEqual([]);
    expect(r.problems.some((p) => p.includes("BOOTSTRAP_OWNER_EMAILS"))).toBe(true);
  });
});

describe("assertMaySignUp (trước khi tạo user)", () => {
  test("email không có trong invites bị chặn", async () => {
    await expect(
      assertMaySignUp(db, [OWNER], { email: "la@example.com", emailVerified: true }),
    ).rejects.toThrow();
  });

  test("email được mời (khác hoa/thường) được phép; email chưa xác minh thì không", async () => {
    await db.insert(invites).values({ email: "khach@example.com" });
    await assertMaySignUp(db, [OWNER], { email: "Khach@Example.com", emailVerified: true });
    await expect(
      assertMaySignUp(db, [OWNER], { email: "khach@example.com", emailVerified: false }),
    ).rejects.toThrow();
  });

  test("lời mời đã dùng không dùng lại được", async () => {
    await db.insert(invites).values({ email: "khach@example.com", usedAt: new Date() });
    await expect(
      assertMaySignUp(db, [OWNER], { email: "khach@example.com", emailVerified: true }),
    ).rejects.toThrow();
  });

  test("email bootstrap được phép khi chưa có owner; danh sách rỗng thì là người lạ", async () => {
    await assertMaySignUp(db, [OWNER], { email: OWNER.toUpperCase(), emailVerified: true });
    await expect(assertMaySignUp(db, [], { email: OWNER, emailVerified: true })).rejects.toThrow();
  });

  test("đã có owner thì email bootstrap không mời cũng bị từ chối; có lời mời thì vẫn qua", async () => {
    await db
      .insert(userTable)
      .values({ id: "u-o", name: "o", email: "o@example.com", emailVerified: true });
    await db.insert(userRoles).values({ userId: "u-o", role: "owner" });
    await expect(
      assertMaySignUp(db, [OWNER], { email: OWNER, emailVerified: true }),
    ).rejects.toThrow();
    await db.insert(invites).values({ email: OWNER });
    await assertMaySignUp(db, [OWNER], { email: OWNER, emailVerified: true });
  });

  test("fail-closed: thiếu bảng user_roles thì email bootstrap bị từ chối", async () => {
    await db.execute(sql`alter table user_roles rename to user_roles_tam`);
    try {
      await expect(
        assertMaySignUp(db, [OWNER], { email: OWNER, emailVerified: true }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table user_roles_tam rename to user_roles`);
    }
  });

  test("fail-closed: truy vấn lỗi hoặc không có bảng thì từ chối", async () => {
    const broken = {
      select() {
        throw new Error("boom");
      },
    } as unknown as Database;
    await expect(
      assertMaySignUp(broken, [OWNER], { email: "khach@example.com", emailVerified: true }),
    ).rejects.toThrow();

    await db.execute(sql`alter table invites rename to invites_tam`);
    try {
      await expect(
        assertMaySignUp(db, [OWNER], { email: "khach@example.com", emailVerified: true }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table invites_tam rename to invites`);
    }
  });

  test("dữ liệu lạ (thiếu email, emailVerified không phải true) bị từ chối", async () => {
    await expect(assertMaySignUp(db, [OWNER], {})).rejects.toThrow();
    await expect(
      assertMaySignUp(db, [OWNER], { email: OWNER, emailVerified: "true" }),
    ).rejects.toThrow();
  });
});

const roleOf = async (userId: string) =>
  (await db.select().from(userRoles).where(eq(userRoles.userId, userId)))[0]?.role;

describe("Better Auth: đăng ký qua hook", () => {
  test("email chưa mời: createOAuthUser bị từ chối, không tạo user nào, không tạo hồ sơ", async () => {
    const auth = makeAuth();
    await expect(oauthSignUp(auth, "la@example.com")).rejects.toThrow();
    expect(await db.select().from(userTable)).toHaveLength(0);
    expect(await profileCount()).toBe(0);
  });

  test("bootstrap: owner nhận hồ sơ chưa-chủ nhỏ nhất, giữ dữ liệu, không tạo hồ sơ mới, không cướp hồ sơ đã có chủ", async () => {
    await db
      .insert(userTable)
      .values({ id: "u-x", name: "x", email: "x@example.com", emailVerified: true });
    await db.insert(profile).values({ id: 3, promptContext: "đã có chủ", userId: "u-x" });
    await db.insert(profile).values({ id: 5, promptContext: "AI engineer", description: "mô tả" });
    await db.insert(profile).values({ id: 7, promptContext: "khác" });
    const u = await oauthSignUp(makeAuth(), "Chu.Du.An@Example.com");
    expect(await profileCount()).toBe(3);
    expect(await profileOf(u.id)).toMatchObject({
      id: 5,
      promptContext: "AI engineer",
      description: "mô tả",
    });
    expect(await roleOf(u.id)).toBe("owner");
    expect((await db.select().from(profile).where(eq(profile.id, 3)))[0]?.userId).toBe("u-x");
    expect((await db.select().from(profile).where(eq(profile.id, 7)))[0]?.userId).toBeNull();
  });

  test("bootstrap khi DB không có hồ sơ chưa chủ: tạo mới, id bắt đầu từ 1 (bảng trống)", async () => {
    const u = await oauthSignUp(makeAuth(), OWNER);
    expect((await profileOf(u.id))?.id).toBe(1);
    expect(await roleOf(u.id)).toBe("owner");
  });

  test("người được mời: role member, hồ sơ trống MỚI (max+1), không nhận hồ sơ chưa chủ có sẵn, lời mời đã dùng", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    await db.insert(invites).values({ email: "khach@example.com" });
    const u = await oauthSignUp(makeAuth(), "khach@example.com");
    expect(await profileCount()).toBe(2);
    expect(await profileOf(u.id)).toMatchObject({ id: 2, promptContext: "", description: null });
    expect(await roleOf(u.id)).toBeUndefined();
    const [inv] = await db.select().from(invites);
    expect(inv?.usedAt).not.toBeNull();
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBeNull();
  });

  test("lời mời role=owner: ghi user_roles owner, hồ sơ trống mới, không nhận hồ sơ cũ; hai owner cùng tồn tại", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    const auth = makeAuth();
    const first = await oauthSignUp(auth, OWNER); // bootstrap, gets profile 1
    await db.insert(profile).values({ id: 2, promptContext: "chưa chủ" });
    await db.insert(invites).values({ email: "owner2@example.com", role: "owner" });
    const second = await oauthSignUp(auth, "owner2@example.com");
    expect((await profileOf(first.id))?.id).toBe(1);
    expect((await profileOf(second.id))?.id).toBe(3); // does not get profile 2
    expect(await roleOf(first.id)).toBe("owner");
    expect(await roleOf(second.id)).toBe("owner");
    expect((await db.select().from(profile).where(eq(profile.id, 2)))[0]?.userId).toBeNull();
  });

  test("có owner rồi: email bootstrap không mời bị từ chối, hồ sơ chưa chủ không bị nối", async () => {
    const auth = makeAuth({ bootstrapOwnerEmails: [OWNER, "b@example.com"] });
    await oauthSignUp(auth, OWNER);
    await db.insert(profile).values({ id: 9, promptContext: "x" });
    await expect(oauthSignUp(auth, "b@example.com")).rejects.toThrow();
    expect((await db.select().from(profile).where(eq(profile.id, 9)))[0]?.userId).toBeNull();
    expect(await db.select().from(userRoles)).toHaveLength(1);
  });

  test("hai email bootstrap đăng nhập đồng thời: chỉ một người thành owner", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "x" });
    const auth = makeAuth({ bootstrapOwnerEmails: ["a@example.com", "b@example.com"] });
    const res = await Promise.allSettled([
      oauthSignUp(auth, "a@example.com"),
      oauthSignUp(auth, "b@example.com"),
    ]);
    const roles = await db.select().from(userRoles);
    expect(roles).toHaveLength(1);
    expect(roles[0]?.role).toBe("owner");
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    // The loser gets no profile and no session (safety net in session.create.before).
    const loser = (await db.select().from(userTable)).find((u) => u.id !== roles[0]?.userId);
    if (loser) {
      expect(await profileOf(loser.id)).toBeUndefined();
      await expect(cookieHeader(auth, loser.id)).rejects.toThrow();
    }
    expect(await profileCount()).toBe(1);
  });

  test("danh sách bootstrap rỗng: email chủ dự án không vào được, hồ sơ không bị nối", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    const auth = makeAuth({ bootstrapOwnerEmails: [] });
    await expect(oauthSignUp(auth, OWNER)).rejects.toThrow();
    expect((await db.select().from(profile))[0]?.userId).toBeNull();
  });

  test("email chưa xác minh bị từ chối, kể cả khi nằm trong danh sách bootstrap", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "AI engineer" });
    const auth = makeAuth();
    await expect(oauthSignUp(auth, OWNER, { verified: false })).rejects.toThrow();
    expect((await db.select().from(profile))[0]?.userId).toBeNull();
  });
});

describe("ensureProfileForUser", () => {
  const mkUser = async (id: string, email: string, invited = true) => {
    await db.insert(userTable).values({ id, name: id, email, emailVerified: true });
    if (invited) await db.insert(invites).values({ email }).onConflictDoNothing();
    return { id, email, emailVerified: true };
  };

  test("thu hồi lời mời: user chưa có hồ sơ mà không còn lời mời thì không nhận hồ sơ mới", async () => {
    const a = await mkUser("u-a", "a@example.com", false); // user exists but has no invite
    await expect(ensureProfileForUser(db, [OWNER], a)).rejects.toThrow();
    expect(await profileCount()).toBe(0);
    await db.insert(invites).values({ email: "a@example.com", usedAt: new Date() }); // used is still enough
    expect(await ensureProfileForUser(db, [OWNER], a)).toBe(1); // empty table: id starts at 1
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

    // Already used (the after hook marked it) so the invite is not deleted, but the user is.
    const r = await revokeInvite(db, "Khach@Example.com");
    expect(r).toEqual({ email: "khach@example.com", inviteRemoved: false, userRemoved: true });
    expect((await app.request("/api/me", { headers: guestHeaders })).status).toBe(401);
    const guestProfile = (await db.select().from(profile).where(eq(profile.id, 2)))[0];
    expect(guestProfile).toBeDefined();
    expect(guestProfile?.userId).toBeNull();
    // Cannot sign in again: the used invite still exists so could sign up again? No: the before-hook requires unused.
    await expect(oauthSignUp(auth, "khach@example.com")).rejects.toThrow();

    // Owner: blocked, profile 1 and the owner account unchanged.
    await expect(revokeInvite(db, OWNER.toUpperCase())).rejects.toThrow();
    expect((await db.select().from(userTable).where(eq(userTable.id, owner.id))).length).toBe(1);
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBe(owner.id);
  });

  test("revoke lời mời chưa dùng: xoá cả lời mời; add chuẩn hoá chữ thường và idempotent", async () => {
    expect(await addInvite(db, " Moi@Example.com ")).toEqual({
      email: "moi@example.com",
      added: true,
      role: "member",
    });
    expect((await addInvite(db, "moi@example.com")).added).toBe(false);
    expect(await listInvites(db)).toHaveLength(1);
    expect(await revokeInvite(db, "moi@example.com")).toEqual({
      email: "moi@example.com",
      inviteRemoved: true,
      userRemoved: false,
    });
    expect(await listInvites(db)).toHaveLength(0);
    await expect(addInvite(db, "khong-phai-email")).rejects.toThrow();
  });

  test("không cướp hồ sơ đã có chủ: owner khởi tạo nhận hồ sơ mới", async () => {
    const a = await mkUser("u-a", "a@example.com");
    await db.insert(profile).values({ id: 1, promptContext: "x", userId: a.id });
    const b = await mkUser("u-b", OWNER, false);
    expect(await ensureProfileForUser(db, [OWNER], b)).toBe(2);
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBe(a.id);
    expect(await roleOf("u-b")).toBe("owner");
  });

  test("idempotent: gọi lại trả cùng hồ sơ, không tạo thêm", async () => {
    await db.insert(profile).values({ id: 1, promptContext: "x" });
    const a = await mkUser("u-a", "a@example.com");
    const first = await ensureProfileForUser(db, [OWNER], a);
    expect(await ensureProfileForUser(db, [OWNER], a)).toBe(first);
    expect(await profileCount()).toBe(2);
  });

  test("chưa xác minh email: ném lỗi, không tạo hồ sơ", async () => {
    await expect(
      ensureProfileForUser(db, [OWNER], { id: "u-x", email: OWNER, emailVerified: false }),
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
      ensureProfileForUser(db, [OWNER], a),
      ensureProfileForUser(db, [OWNER], b),
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
    await db.delete(profile).where(eq(profile.userId, u.id)); // profile disappears after a session exists
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
    await cookieHeader(auth, u.id); // create session → session hook re-links
    expect(await profileOf(u.id)).toBeDefined();
    // Unverified email: cannot link, so no session.
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
