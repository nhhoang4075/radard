/**
 * Ghi một lượt bấm 👍/👎 vào `feedback`. Chỉ ghi thêm: bấm 👍 rồi đổi ý 👎 là hai dòng, dòng mới
 * nhất là ý kiến hiện tại. Bấm lại đúng nút vừa bấm (👍 rồi 👍) không ghi thêm: không có ý mới,
 * chỉ làm lịch sử khó đọc (quyết định 13/10/2026). Khi đếm, mỗi tin lấy dòng mới nhất.
 *
 * Không ghi trùng khi kênh giao lại cùng lượt bấm: `source_message_id` = id của lượt bấm, và khoá
 * duy nhất (channel, recipient, source_message_id) chặn dòng thứ hai.
 */
import type { FeedbackEvent } from "@radard/core";
import { createLogger } from "@radard/core";
import { type Database, deliveries, feedback } from "@radard/db";
import { and, desc, eq, inArray } from "drizzle-orm";

const log = createLogger("feedback");

export async function recordFeedback(
  db: Database,
  ev: FeedbackEvent,
): Promise<{ recorded: boolean; deliveryId: number | null; reason?: "replayed" | "unchanged" }> {
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
  if (deliveryId !== null) {
    const [last] = await db
      .select({ kind: feedback.kind })
      .from(feedback)
      .where(
        and(
          eq(feedback.deliveryId, deliveryId),
          eq(feedback.recipient, ev.recipient),
          // Nhận xét bằng chữ (sau này) không phải "ý kiến hiện tại" về nút.
          inArray(feedback.kind, ["like", "dislike"]),
        ),
      )
      .orderBy(desc(feedback.id))
      .limit(1);
    if (last?.kind === ev.kind) {
      log.info("bấm lại nút cũ, không ghi thêm", { kind: ev.kind, deliveryId });
      return { recorded: false, deliveryId, reason: "unchanged" };
    }
  }
  const rows = await db
    .insert(feedback)
    .values({
      deliveryId,
      channel: ev.channel,
      recipient: ev.recipient,
      kind: ev.kind,
      sourceMessageId: ev.sourceId,
      meta: { messageId: ev.messageId },
    })
    .onConflictDoNothing()
    .returning({ id: feedback.id });
  const recorded = rows.length > 0;
  log.info(recorded ? "đã ghi phản hồi" : "lượt bấm đã ghi từ trước", {
    kind: ev.kind,
    deliveryId,
  });
  return recorded ? { recorded, deliveryId } : { recorded, deliveryId, reason: "replayed" };
}
