/** Owner nằm trong DB: middleware isOwner (phiên thật), CLI owners/relink/revoke. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDatabase,
  invites,
  profile,
  runMigrations,
  userRoles,
  user as userTable,
} from "@radard/db";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuth } from "../src/web/auth.ts";
import { addInvite, revokeInvite } from "../src/web/invites.ts";
import { ownerOnly } from "../src/web/middleware/owner-only.ts";
import { type SessionEnv, sessionMiddleware } from "../src/web/middleware/session.ts";
import { addOwner, listOwners, relinkProfile, removeOwner } from "../src/web/owners.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 4 });
const BOOT = "boot@example.com";
const auth = createAuth({
  db,
  config: {
    secret: "khoa-thu-nghiem-0123456789-0123456789",
    baseURL: "http://localhost:8080",
    bootstrapOwnerEmails: [BOOT],
    providers: {},
  },
  plugins: [testUtils()],
});

async function signUp(email: string) {
  const ctx = await auth.$context;
  const { user } = await ctx.internalAdapter.createOAuthUser(
    { email, name: email, emailVerified: true },
    { providerId: "github", accountId: `gh-${email}` },
  );
  return user;
}
async function headersFor(userId: string): Promise<Headers> {
  const ctx = (await auth.$context) as unknown as {
    test: { login(o: { userId: string }): Promise<{ headers: Headers }> };
  };
  return (await ctx.test.login({ userId })).headers;
}
const owners = async () => (await listOwners(db)).map((o) => o.email).sort();

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

describe("owner-only với phiên thật", () => {
  const app = new Hono<SessionEnv>()
    .use("*", sessionMiddleware({ db, auth }))
    .get("/owner", ownerOnly(), (c) => c.text("ok"));

  test("member 403, owner 200, gỡ role có hiệu lực ngay ở request sau", async () => {
    const owner = await signUp(BOOT);
    await db.insert(invites).values({ email: "m@example.com" });
    const member = await signUp("m@example.com");
    expect((await app.request("/owner", { headers: await headersFor(member.id) })).status).toBe(
      403,
    );
    const oh = await headersFor(owner.id);
    expect((await app.request("/owner", { headers: oh })).status).toBe(200);
    await addOwner(db, "m@example.com");
    await removeOwner(db, BOOT);
    expect((await app.request("/owner", { headers: oh })).status).toBe(403);
    expect((await app.request("/owner", { headers: await headersFor(member.id) })).status).toBe(
      200,
    );
  });
});

describe("owners add / remove", () => {
  test("user đã có: cấp owner; chưa có: lời mời role=owner rồi đăng nhập thành owner; hai owner", async () => {
    await signUp(BOOT);
    expect(await addOwner(db, "Moi@Example.com")).toEqual({
      email: "moi@example.com",
      kind: "invited",
    });
    expect((await db.select().from(invites))[0]?.role).toBe("owner");
    await signUp("moi@example.com");
    expect(await owners()).toEqual([BOOT, "moi@example.com"]);
    expect((await addOwner(db, BOOT)).kind).toBe("already");
    await db
      .insert(userTable)
      .values({ id: "u-n", name: "n", email: "n@example.com", emailVerified: true });
    expect((await addOwner(db, "n@example.com")).kind).toBe("granted");
    await expect(addOwner(db, "khong-phai-email")).rejects.toThrow();
  });

  test("owners remove: từ chối owner cuối, được khi còn người khác, không xoá user", async () => {
    const a = await signUp(BOOT);
    await expect(removeOwner(db, BOOT)).rejects.toThrow(/cuối/);
    await addOwner(db, "b@example.com");
    await signUp("b@example.com");
    await removeOwner(db, BOOT);
    expect(await owners()).toEqual(["b@example.com"]);
    expect((await db.select().from(userTable).where(eq(userTable.id, a.id))).length).toBe(1);
    await expect(removeOwner(db, BOOT)).rejects.toThrow(/không phải owner/);
    await expect(removeOwner(db, "b@example.com")).rejects.toThrow(/cuối/);
  });

  test("hai lệnh gỡ đồng thời không để lại 0 owner", async () => {
    await signUp(BOOT);
    await addOwner(db, "b@example.com");
    await signUp("b@example.com");
    const r = await Promise.allSettled([removeOwner(db, BOOT), removeOwner(db, "b@example.com")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(userRoles)).toHaveLength(1);
  });
});

describe("invites add --role / revoke", () => {
  test("add role owner; chạy lại không đổi; revoke owner bị từ chối, member được", async () => {
    expect(await addInvite(db, "o@example.com", "owner")).toMatchObject({
      added: true,
      role: "owner",
    });
    expect(await addInvite(db, "o@example.com", "member")).toMatchObject({
      added: false,
      role: "owner",
    });
    const o = await signUp("o@example.com");
    expect(await owners()).toEqual(["o@example.com"]);
    await expect(revokeInvite(db, "O@Example.com")).rejects.toThrow(/owner/);
    expect((await db.select().from(userTable).where(eq(userTable.id, o.id))).length).toBe(1);
    await addInvite(db, "m@example.com");
    await signUp("m@example.com");
    expect((await revokeInvite(db, "m@example.com")).userRemoved).toBe(true);
  });
});

describe("profiles relink", () => {
  test("không --yes chỉ báo; có --yes nối, user cũ mất hồ sơ; hồ sơ/user lạ hoặc user đã có hồ sơ khác bị từ chối", async () => {
    const a = await signUp(BOOT); // hồ sơ 1
    await addInvite(db, "b@example.com");
    const b = await signUp("b@example.com"); // hồ sơ 2
    await db
      .insert(userTable)
      .values({ id: "u-c", name: "c", email: "c@example.com", emailVerified: true });

    const plan = await relinkProfile(db, 1, "c@example.com", false);
    expect(plan).toMatchObject({
      applied: false,
      noop: false,
      previousUser: { id: a.id, email: BOOT },
    });
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBe(a.id);

    await expect(relinkProfile(db, 1, "b@example.com", true)).rejects.toThrow(/hồ sơ 2/);
    await expect(relinkProfile(db, 99, "c@example.com", true)).rejects.toThrow(/không có hồ sơ/);
    await expect(relinkProfile(db, 1, "none@example.com", true)).rejects.toThrow(/không có user/);

    const done = await relinkProfile(db, 1, "c@example.com", true);
    expect(done.applied).toBe(true);
    expect((await db.select().from(profile).where(eq(profile.id, 1)))[0]?.userId).toBe("u-c");
    expect((await db.select().from(profile).where(eq(profile.userId, a.id))).length).toBe(0);
    expect((await db.select().from(profile).where(eq(profile.id, 2)))[0]?.userId).toBe(b.id);
    expect((await relinkProfile(db, 1, "c@example.com", true)).noop).toBe(true);
  });
});
