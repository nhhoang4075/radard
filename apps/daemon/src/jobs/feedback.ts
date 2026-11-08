/**
 * Ghi một lượt bấm 👍/👎 vào `feedback`. Chỉ ghi thêm: bấm 👍 rồi đổi ý 👎 là hai dòng, dòng mới
 * nhất là ý kiến hiện tại. Bấm lại đúng nút đang chọn là BỎ CHỌN: ghi một dòng `clear`, ý kiến hiện
 * tại thành "chưa chọn" (quyết định 09/11/2026, thay quyết định 13/10/2026 là bấm lại thì bỏ qua).
 * Khi đếm, mỗi tin lấy dòng mới nhất; `clear` không tính là đã có phản hồi.
 *
 * Bấm lại đúng nút trong vòng `DOUBLE_TAP_MS` kể từ dòng vừa ghi coi là bấm đúp, không bỏ chọn:
 * hai lượt bấm gần như cùng lúc là một ý.
 *
 * Không ghi trùng khi kênh giao lại cùng lượt bấm: `source_message_id` = id của lượt bấm, và khoá
 * duy nhất (channel, recipient, source_message_id) chặn dòng thứ hai.
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
): Promise<{
  recorded: boolean;
  deliveryId: number | null;
  /** Ý kiến hiện tại của tin sau lượt bấm. */
  state: FeedbackState;
  reason?: "replayed" | "unchanged";
}> {
  const [d] = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.channel, ev.channel),
        eq(deliveries.recipient, ev.recipient),
        eq(deliveries.messageId, ev.messageId),
      ),
    );
  // Không tìm thấy tin (tin không do radard ghi lại): vẫn giữ phản hồi, `delivery_id` trống.
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
          // Nhận xét bằng chữ (sau này) không phải "ý kiến hiện tại" về nút.
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
      deliveryId,
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
