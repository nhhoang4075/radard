/**
 * Invite management (CLI `invites add|list|revoke`). Emails are always lowercased.
 *
 * Revoke = delete the UNUSED invite and the `user` row with the same email (FK cascade removes sessions and accounts;
 * `profile.user_id` becomes NULL thanks to ON DELETE SET NULL, while the profile and its data are kept). Never
 * revokes the email of a user who holds the owner role (see `owners remove`).
 */
import { type Database, invites, user, userRoles } from "@radard/db";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeEmail } from "./email.ts";

function must(email: string): string {
  const e = normalizeEmail(email);
  if (!e) throw new Error("email không hợp lệ");
  return e;
}

export type InviteRole = "owner" | "member";

export function parseRole(v: string): InviteRole {
  if (v === "owner" || v === "member") return v;
  throw new Error(`--role phải là owner hoặc member, nhận "${v}"`);
}

/** An existing invite is kept as it is (including its role); the returned `role` is the one stored. */
export async function addInvite(
  db: Database,
  email: string,
  role: InviteRole = "member",
): Promise<{ email: string; added: boolean; role: InviteRole }> {
  const e = must(email);
  const rows = await db
    .insert(invites)
    .values({ email: e, role })
    .onConflictDoNothing()
    .returning({ id: invites.id });
  if (rows.length > 0) return { email: e, added: true, role };
  const [cur] = await db.select({ role: invites.role }).from(invites).where(eq(invites.email, e));
  return { email: e, added: false, role: cur?.role === "owner" ? "owner" : "member" };
}

export const listInvites = (db: Database) => db.select().from(invites).orderBy(invites.id);

export async function revokeInvite(
  db: Database,
  email: string,
): Promise<{ email: string; inviteRemoved: boolean; userRemoved: boolean }> {
  const e = must(email);
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .innerJoin(userRoles, eq(userRoles.userId, user.id))
      .where(and(eq(user.email, e), eq(userRoles.role, "owner")))
      .limit(1);
    if (owner) throw new Error(`${e} là owner: gỡ vai trò bằng "owners remove" trước`);
    const inv = await tx
      .delete(invites)
      .where(and(eq(invites.email, e), isNull(invites.usedAt)))
      .returning({ id: invites.id });
    const usr = await tx.delete(user).where(eq(user.email, e)).returning({ id: user.id });
    return { email: e, inviteRemoved: inv.length > 0, userRemoved: usr.length > 0 };
  });
}
