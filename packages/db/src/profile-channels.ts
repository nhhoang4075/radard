/**
 * Tra và seed ánh xạ người nhận → hồ sơ (bảng `profile_channels`). Không gắn kênh nào cụ thể.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { profile } from "./schema/profile.ts";
import { profileChannels } from "./schema/profile-channels.ts";

/**
 * Hồ sơ của người nhận, hoặc `null` nếu không có trong bảng hay đã tắt. `null` nghĩa là KHÔNG có
 * quyền: người gọi phải bỏ qua, không đọc hay ghi dữ liệu của hồ sơ nào.
 */
export async function profileOf(
  db: Database,
  channel: string,
  recipient: string,
): Promise<number | null> {
  const [row] = await db
    .select({ profileId: profileChannels.profileId })
    .from(profileChannels)
    .where(
      and(
        eq(profileChannels.channel, channel),
        eq(profileChannels.recipient, recipient),
        eq(profileChannels.enabled, true),
      ),
    );
  return row?.profileId ?? null;
}

/** Mọi người nhận đang bật của một kênh, kèm hồ sơ; thứ tự ổn định theo id. */
export async function enabledRecipients(
  db: Database,
  channel: string,
): Promise<Array<{ profileId: number; recipient: string }>> {
  return db
    .select({ profileId: profileChannels.profileId, recipient: profileChannels.recipient })
    .from(profileChannels)
    .where(and(eq(profileChannels.channel, channel), eq(profileChannels.enabled, true)))
    .orderBy(asc(profileChannels.id));
}

/**
 * Nối người nhận với hồ sơ nếu hồ sơ tồn tại; chạy lại nhiều lần không đổi gì (người nhận đã có
 * dòng, thuộc hồ sơ nào cũng giữ nguyên). Trả `true` khi vừa thêm dòng mới.
 */
export async function seedProfileChannel(
  db: Database,
  o: { profileId: number; channel: string; recipient: string },
): Promise<boolean> {
  const [p] = await db.select({ id: profile.id }).from(profile).where(eq(profile.id, o.profileId));
  if (!p) return false;
  const rows = await db
    .insert(profileChannels)
    .values({ profileId: o.profileId, channel: o.channel, recipient: o.recipient })
    .onConflictDoNothing()
    .returning({ id: profileChannels.id });
  return rows.length > 0;
}
