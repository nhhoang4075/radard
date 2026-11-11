/**
 * Lookup and seed of the recipient → profile mapping (table `profile_channels`). Does not bind any specific channel.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { profile } from "./schema/profile.ts";
import { profileChannels } from "./schema/profile-channels.ts";

/**
 * The recipient's profile, or `null` if not in the table or disabled. `null` means NO
 * access: the caller must skip it, reading or writing no profile's data.
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

/** All enabled recipients of a channel, with profiles; stable order by id. */
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
 * Links the recipient to the profile if the profile exists; running it again changes nothing (a recipient that already has
 * a row keeps whichever profile it belongs to). Returns `true` when a new row was just added.
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
