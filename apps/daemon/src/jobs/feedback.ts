/**
 * Records one 👍/👎 press into `feedback`. Append-only: pressing 👍 then 👎 gives two rows; the newest row
 * is the current opinion. Pressing the same button again (the one already selected) UNSELECTS it: it writes a `clear` row, making the current
 * opinion "not selected" (decision 09/11/2026, replacing the decision of 13/10/2026 that a repeat press is ignored).
 * When counting, each delivery uses its newest row; `clear` does not count as feedback.
 *
 * A repeat press of the same button within `DOUBLE_TAP_MS` of the row just written counts as a double tap, not an unselect:
 * two presses almost at the same time are one opinion.
 *
 * No duplicate writes when the channel redelivers the same press: `source_message_id` = the id of the press, and the unique key
 * (channel, recipient, source_message_id) blocks the second row.
 */
import type { FeedbackEvent, FeedbackState } from "@radard/core";
import { createLogger } from "@radard/core";
import { type Database, deliveries, feedback } from "@radard/db";
import { and, desc, eq, inArray } from "drizzle-orm";

const log = createLogger("feedback");

const DOUBLE_TAP_MS = 2_000;

export async function recordFeedback(
  db: Database,
  ev: FeedbackEvent,
  /** Profile to assign the feedback to when no item is found; if there is an item, use that item's profile. */
  profileId: number,
): Promise<{
  recorded: boolean;
  deliveryId: number | null;
  /** The item's current opinion after this press. */
  state: FeedbackState;
  reason?: "replayed" | "unchanged";
}> {
  const [d] = await db
    .select({
      id: deliveries.id,
      profileId: deliveries.profileId,
      feedItemId: deliveries.feedItemId,
    })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.channel, ev.channel),
        eq(deliveries.recipient, ev.recipient),
        eq(deliveries.messageId, ev.messageId),
      ),
    );
  // Item not found (not recorded by radard): still keep the feedback, with `delivery_id` empty.
  const deliveryId = d?.id ?? null;
  let kind: "like" | "dislike" | "clear" = ev.kind;
  if (deliveryId !== null) {
    const [last] = await db
      .select({ kind: feedback.kind, createdAt: feedback.createdAt })
      .from(feedback)
      .where(
        and(
          eq(feedback.deliveryId, deliveryId),
          eq(feedback.recipient, ev.recipient),
          // A text comment (later) is not the "current opinion" about the button.
          inArray(feedback.kind, ["like", "dislike", "clear"]),
        ),
      )
      .orderBy(desc(feedback.id))
      .limit(1);
    if (last?.kind === ev.kind) {
      if (Date.now() - last.createdAt.getTime() < DOUBLE_TAP_MS) {
        log.info("bấm đúp, không bỏ chọn", { kind: ev.kind, deliveryId });
        return { recorded: false, deliveryId, state: ev.kind, reason: "unchanged" };
      }
      kind = "clear";
    }
  }
  const rows = await db
    .insert(feedback)
    .values({
      // For a known item, the feedback belongs to the item's own profile, regardless of the caller that links it.
      profileId: d?.profileId ?? profileId,
      deliveryId,
      // Item sent from the feed snapshot: link the feedback to the feed item, so web and Telegram share one opinion.
      feedItemId: d?.feedItemId ?? null,
      channel: ev.channel,
      recipient: ev.recipient,
      kind,
      sourceMessageId: ev.sourceId,
      meta: { messageId: ev.messageId },
    })
    .onConflictDoNothing()
    .returning({ id: feedback.id });
  const recorded = rows.length > 0;
  log.info(recorded ? "đã ghi phản hồi" : "lượt bấm đã ghi từ trước", { kind, deliveryId });
  if (!recorded) return { recorded, deliveryId, state: ev.kind, reason: "replayed" };
  return { recorded, deliveryId, state: kind === "clear" ? "none" : kind };
}
