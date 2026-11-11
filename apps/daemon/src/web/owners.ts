/**
 * Quản lý owner và nối hồ sơ (CLI `owners`, `owners add|remove`, `profiles relink`). Owner nằm trong DB
 * (`user_roles`), không nằm trong biến môi trường. Email luôn chuẩn hoá chữ thường.
 */
import { type Database, invites, profile, user, userRoles } from "@radard/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { normalizeEmail } from "./email.ts";
import { PROFILE_LOCK_KEY } from "./profile-lock.ts";

function must(email: string): string {
  const e = normalizeEmail(email);
  if (!e) throw new Error("email không hợp lệ");
  return e;
}

export async function listOwners(db: Database) {
  return db
    .select({ userId: user.id, email: user.email, name: user.name, since: userRoles.createdAt })
    .from(userRoles)
    .innerJoin(user, eq(user.id, userRoles.userId))
    .where(eq(userRoles.role, "owner"))
    .orderBy(userRoles.createdAt, user.email);
}

export type AddOwnerResult =
  | { email: string; kind: "granted" | "already" }
  | { email: string; kind: "invited" | "invite_updated" };

/** User đã có: cấp owner. Chưa có: tạo (hoặc nâng) lời mời role=owner để người đó đăng nhập là thành owner. */
export async function addOwner(db: Database, email: string): Promise<AddOwnerResult> {
  const e = must(email);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_LOCK_KEY})`);
    const [u] = await tx.select({ id: user.id }).from(user).where(eq(user.email, e));
    if (u) {
      const rows = await tx
        .insert(userRoles)
        .values({ userId: u.id, role: "owner" })
        .onConflictDoUpdate({
          target: userRoles.userId,
          set: { role: "owner" },
          setWhere: ne(userRoles.role, "owner"),
        })
        .returning({ userId: userRoles.userId });
      return { email: e, kind: rows.length > 0 ? "granted" : "already" } as const;
    }
    const [inv] = await tx.select().from(invites).where(eq(invites.email, e));
    if (!inv) {
      await tx.insert(invites).values({ email: e, role: "owner" });
      return { email: e, kind: "invited" } as const;
    }
    if (inv.role === "owner" && inv.usedAt === null)
      return { email: e, kind: "invite_updated" } as const;
    // Lời mời member, hoặc lời mời đã dùng mà user không còn (đã thu hồi): mở lại với role owner.
    await tx.update(invites).set({ role: "owner", usedAt: null }).where(eq(invites.id, inv.id));
    return { email: e, kind: "invite_updated" } as const;
  });
}

/** Xoá dòng role owner (không xoá user). Từ chối khi đó là owner cuối cùng. */
export async function removeOwner(db: Database, email: string): Promise<{ email: string }> {
  const e = must(email);
  return db.transaction(async (tx) => {
    // Khoá mọi dòng owner: hai lệnh gỡ đồng thời không cùng thấy "còn người khác".
    const owners = await tx
      .select({ userId: userRoles.userId, email: user.email })
      .from(userRoles)
      .innerJoin(user, eq(user.id, userRoles.userId))
      .where(eq(userRoles.role, "owner"))
      .for("update", { of: userRoles });
    const target = owners.find((o) => o.email === e);
    if (!target) throw new Error(`${e} không phải owner`);
    if (owners.length <= 1) throw new Error("không gỡ được owner cuối cùng");
    await tx.delete(userRoles).where(eq(userRoles.userId, target.userId));
    return { email: e };
  });
}

export interface RelinkPlan {
  profileId: number;
  email: string;
  userId: string;
  /** User đang giữ hồ sơ này (sẽ bị gỡ); null nếu hồ sơ chưa có chủ. */
  previousUser: { id: string; email: string | null } | null;
  /** Hồ sơ đã thuộc đúng user đó rồi: không có gì để đổi. */
  noop: boolean;
  applied: boolean;
}

/**
 * Đặt `profile.user_id` = user có email đó. Hồ sơ phải tồn tại; user phải tồn tại và chưa có hồ sơ khác.
 * `apply=false` chỉ trả điều sẽ xảy ra. User cũ của hồ sơ bị gỡ (hồ sơ cũ của họ không còn chủ).
 */
export async function relinkProfile(
  db: Database,
  profileId: number,
  email: string,
  apply: boolean,
): Promise<RelinkPlan> {
  const e = must(email);
  if (!Number.isInteger(profileId) || profileId < 1) throw new Error("mã hồ sơ không hợp lệ");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_LOCK_KEY})`);
    const [p] = await tx
      .select({ id: profile.id, userId: profile.userId })
      .from(profile)
      .where(eq(profile.id, profileId))
      .for("update");
    if (!p) throw new Error(`không có hồ sơ ${profileId}`);
    const [u] = await tx.select({ id: user.id }).from(user).where(eq(user.email, e));
    if (!u) throw new Error(`không có user với email ${e}`);
    const [other] = await tx
      .select({ id: profile.id })
      .from(profile)
      .where(and(eq(profile.userId, u.id), ne(profile.id, profileId)));
    if (other) throw new Error(`${e} đang giữ hồ sơ ${other.id}: không nối thêm hồ sơ thứ hai`);
    let previousUser: RelinkPlan["previousUser"] = null;
    if (p.userId !== null && p.userId !== u.id) {
      const [pu] = await tx.select({ email: user.email }).from(user).where(eq(user.id, p.userId));
      previousUser = { id: p.userId, email: pu?.email ?? null };
    }
    const noop = p.userId === u.id;
    if (apply && !noop) {
      await tx.update(profile).set({ userId: u.id }).where(eq(profile.id, profileId));
    }
    return { profileId, email: e, userId: u.id, previousUser, noop, applied: apply && !noop };
  });
}
