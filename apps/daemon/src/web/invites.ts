/**
 * Quản lý lời mời (CLI `invites add|list|revoke`). Email luôn chuẩn hoá chữ thường.
 *
 * Thu hồi = xoá lời mời CHƯA dùng và xoá dòng `user` cùng email (FK cascade xoá session/account;
 * `profile.user_id` về NULL nhờ ON DELETE SET NULL, hồ sơ và dữ liệu của nó giữ nguyên). Không bao
 * giờ thu hồi email `OWNER_EMAIL`.
 */
import { type Database, invites, user } from "@radard/db";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeEmail } from "./email.ts";

function must(email: string): string {
  const e = normalizeEmail(email);
  if (!e) throw new Error("email không hợp lệ");
  return e;
}

export async function addInvite(
  db: Database,
  email: string,
): Promise<{ email: string; added: boolean }> {
  const e = must(email);
  const rows = await db
    .insert(invites)
    .values({ email: e })
    .onConflictDoNothing()
    .returning({ id: invites.id });
  return { email: e, added: rows.length > 0 };
}

export const listInvites = (db: Database) => db.select().from(invites).orderBy(invites.id);

export async function revokeInvite(
  db: Database,
  ownerEmail: string | null,
  email: string,
): Promise<{ email: string; inviteRemoved: boolean; userRemoved: boolean }> {
  const e = must(email);
  if (ownerEmail && e === ownerEmail) {
    throw new Error("không thu hồi được email chủ dự án (OWNER_EMAIL)");
  }
  return db.transaction(async (tx) => {
    const inv = await tx
      .delete(invites)
      .where(and(eq(invites.email, e), isNull(invites.usedAt)))
      .returning({ id: invites.id });
    const usr = await tx.delete(user).where(eq(user.email, e)).returning({ id: user.id });
    return { email: e, inviteRemoved: inv.length > 0, userRemoved: usr.length > 0 };
  });
}
