/**
 * Owner management and profile linking (CLI `owners`, `owners add|remove`, `profiles relink`). Owners live in the DB
 * (`user_roles`), not in environment variables. Emails are always lowercased.
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

/** User exists: grant owner. Not yet: create (or upgrade) an invite with role=owner, so that person becomes an owner when signing in. */
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
    // A member invite, or a used invite whose user is gone (revoked): reopen it with role owner.
    await tx.update(invites).set({ role: "owner", usedAt: null }).where(eq(invites.id, inv.id));
    return { email: e, kind: "invite_updated" } as const;
  });
}

/** Deletes the owner role row (does not delete the user). Refuses when this is the last owner. */
export async function removeOwner(db: Database, email: string): Promise<{ email: string }> {
  const e = must(email);
  return db.transaction(async (tx) => {
    // Lock every owner row: two concurrent removals must not both see "someone else still remains".
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
  /** The user currently holding this profile (will be unlinked); null if the profile has no owner. */
  previousUser: { id: string; email: string | null } | null;
  /** The profile already belongs to that exact user: nothing to change. */
  noop: boolean;
  applied: boolean;
}

/**
 * Sets `profile.user_id` to the user with that email. The profile must exist; the user must exist and not yet have another profile.
 * `apply=false` only reports what would happen. The profile's previous user is removed from it (their old profile then has no owner).
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
