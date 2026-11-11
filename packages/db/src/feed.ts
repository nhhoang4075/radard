/**
 * Đọc/ghi feed cho vai trò web (endpoint HTTP do phần web làm). Mọi hàm nhận `profileId` của người
 * đang đăng nhập và LỌC theo nó: không có hàm nào đọc hay ghi dữ liệu của hồ sơ khác (fail-closed).
 * Đầu vào sai (bản chụp của hồ sơ khác, vị trí không tồn tại) thì không ghi gì.
 *
 * Bản chụp do daemon dựng (apps/daemon/src/jobs/feed.ts); ở đây chỉ đọc bản `ready`.
 */
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { deliveries, feedback } from "./schema/delivery.ts";
import { feedImpressions, feedItems, feedSnapshots } from "./schema/feed.ts";

export type FeedSnapshot = typeof feedSnapshots.$inferSelect;
export type FeedItem = typeof feedItems.$inferSelect;

/** Bản chụp `ready` mới nhất của hồ sơ (hoặc của đúng khung `periodEnd`), `null` nếu chưa có. */
export async function latestFeedSnapshot(
  db: Database,
  profileId: number,
  periodEnd?: Date,
): Promise<FeedSnapshot | null> {
  const [row] = await db
    .select()
    .from(feedSnapshots)
    .where(
      and(
        eq(feedSnapshots.profileId, profileId),
        eq(feedSnapshots.status, "ready"),
        periodEnd ? eq(feedSnapshots.periodEnd, periodEnd) : undefined,
      ),
    )
    .orderBy(desc(feedSnapshots.periodEnd))
    .limit(1);
  return row ?? null;
}

/**
 * Một trang của bản chụp theo con trỏ vị trí: các tin có vị trí > `after`, tối đa `limit`. Bản chụp
 * không thuộc hồ sơ thì trả rỗng. `done` = đã hết K tin của bản chụp ("hết tin hôm nay").
 */
export async function feedPage(
  db: Database,
  q: { profileId: number; snapshotId: number; after?: number; limit?: number },
): Promise<{ items: FeedItem[]; nextAfter: number | null; done: boolean }> {
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 100);
  const items = await db
    .select()
    .from(feedItems)
    .where(
      and(
        eq(feedItems.profileId, q.profileId),
        eq(feedItems.snapshotId, q.snapshotId),
        gt(feedItems.position, q.after ?? 0),
      ),
    )
    .orderBy(asc(feedItems.position))
    .limit(limit + 1);
  const page = items.slice(0, limit);
  const more = items.length > limit;
  return { items: page, nextAfter: more ? (page.at(-1)?.position ?? null) : null, done: !more };
}

export interface ImpressionInput {
  snapshotId: number;
  position: number;
}

export type ImpressionResult =
  | { ok: true; inserted: number; duplicate: number }
  | { ok: false; invalid: ImpressionInput[] };

/**
 * Ghi một lô lượt hiện. Kiểm trước khi ghi: mọi (bản chụp, vị trí) phải là tin có thật của bản chụp
 * thuộc `profileId`; có MỘT mục sai thì không ghi gì và trả các mục sai. Idempotent: (bản chụp, vị
 * trí) đã có lượt hiện thì bỏ qua, giữ `seen_at` đầu tiên. `seen_at` là giờ máy chủ (không tin giờ
 * của trình duyệt). Khoá ngoại ghép (profile_id, snapshot_id, position) chặn thêm một lần ở DB.
 */
export async function recordImpressions(
  db: Database,
  profileId: number,
  entries: readonly ImpressionInput[],
): Promise<ImpressionResult> {
  const valid = (e: ImpressionInput) =>
    Number.isSafeInteger(e.snapshotId) &&
    e.snapshotId > 0 &&
    Number.isSafeInteger(e.position) &&
    e.position > 0;
  const malformed = entries.filter((e) => !valid(e));
  if (malformed.length > 0) return { ok: false, invalid: malformed };
  const key = (e: ImpressionInput) => `${e.snapshotId}:${e.position}`;
  const unique = [...new Map(entries.map((e) => [key(e), e])).values()];
  if (unique.length === 0) return { ok: true, inserted: 0, duplicate: 0 };

  const snapshotIds = [...new Set(unique.map((e) => e.snapshotId))];
  const owned = new Set(
    (
      await db
        .select({ snapshotId: feedItems.snapshotId, position: feedItems.position })
        .from(feedItems)
        .where(and(eq(feedItems.profileId, profileId), inArray(feedItems.snapshotId, snapshotIds)))
    ).map(key),
  );
  const invalid = unique.filter((e) => !owned.has(key(e)));
  if (invalid.length > 0) return { ok: false, invalid };

  const rows = await db
    .insert(feedImpressions)
    .values(unique.map((e) => ({ profileId, snapshotId: e.snapshotId, position: e.position })))
    .onConflictDoNothing({ target: [feedImpressions.snapshotId, feedImpressions.position] })
    .returning({ id: feedImpressions.id });
  return { ok: true, inserted: rows.length, duplicate: unique.length - rows.length };
}

export interface ScrollDepth {
  snapshotId: number;
  periodEnd: Date;
  /** Số tin của bản chụp (K của ngày đó). */
  itemCount: number;
  /** Vị trí lớn nhất đã hiện; 0 khi ngày đó không có lượt hiện nào. */
  deepestPosition: number;
  /** Cuộn hết bản chụp: dữ liệu bị chặn (không biết người dùng còn muốn đọc thêm bao nhiêu). */
  censored: boolean;
}

/**
 * Độ sâu cuộn tối đa mỗi ngày (mỗi bản chụp `ready` có `period_end` trong [from, to)) của hồ sơ, cũ
 * đến mới. Dữ liệu để ước lượng h của θk = (1 − h)^(k−1) sau này; chưa dùng ở đâu.
 */
export async function scrollDepths(
  db: Database,
  q: { profileId: number; from: Date; to: Date },
): Promise<ScrollDepth[]> {
  const rows = await db
    .select({
      snapshotId: feedSnapshots.id,
      periodEnd: feedSnapshots.periodEnd,
      itemCount: feedSnapshots.itemCount,
      deepest: sql<number>`coalesce(max(${feedImpressions.position}), 0)::int`,
    })
    .from(feedSnapshots)
    .leftJoin(
      feedImpressions,
      and(
        eq(feedImpressions.snapshotId, feedSnapshots.id),
        eq(feedImpressions.profileId, feedSnapshots.profileId),
      ),
    )
    .where(
      and(
        eq(feedSnapshots.profileId, q.profileId),
        eq(feedSnapshots.status, "ready"),
        gte(feedSnapshots.periodEnd, q.from),
        lt(feedSnapshots.periodEnd, q.to),
      ),
    )
    .groupBy(feedSnapshots.id)
    .orderBy(asc(feedSnapshots.periodEnd));
  return rows.map((r) => {
    const itemCount = r.itemCount ?? 0;
    const deepestPosition = Number(r.deepest);
    return {
      snapshotId: r.snapshotId,
      periodEnd: r.periodEnd,
      itemCount,
      deepestPosition,
      censored: itemCount > 0 && deepestPosition >= itemCount,
    };
  });
}

/** Kênh ghi vào `feedback.channel` cho phản hồi từ web. */
export const WEB_FEEDBACK_CHANNEL = "web";

export type FeedFeedbackResult =
  | { ok: true; feedbackId: number; state: "like" | "dislike" | "none" }
  | { ok: false; reason: "not_found" };

/**
 * Phản hồi 👍/👎 từ web cho một tin feed. Cùng quy ước với phản hồi Telegram (jobs/feedback.ts):
 * chỉ ghi thêm; bấm lại đúng nút đang chọn là bỏ chọn (dòng `clear`). Ý kiến hiện tại của tin là dòng
 * mới nhất có `feed_item_id` này, dù đến từ Telegram hay web. Tin không thuộc `profileId` thì
 * `not_found`, không ghi gì. Tin đã gửi qua Telegram thì dòng mới cũng mang `delivery_id` của tin đó,
 * để phần đọc phản hồi theo delivery hiện có (cụm gu) thấy cả phản hồi từ web.
 */
export async function recordFeedFeedback(
  db: Database,
  q: { profileId: number; feedItemId: number; kind: "like" | "dislike" },
): Promise<FeedFeedbackResult> {
  if (!Number.isSafeInteger(q.feedItemId) || q.feedItemId <= 0) {
    return { ok: false, reason: "not_found" };
  }
  const [item] = await db
    .select({ id: feedItems.id })
    .from(feedItems)
    .where(and(eq(feedItems.id, q.feedItemId), eq(feedItems.profileId, q.profileId)));
  if (!item) return { ok: false, reason: "not_found" };
  const [delivery] = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.feedItemId, item.id),
        eq(deliveries.profileId, q.profileId),
        eq(deliveries.kind, "event"),
      ),
    )
    .orderBy(asc(deliveries.id))
    .limit(1);
  const [last] = await db
    .select({ kind: feedback.kind })
    .from(feedback)
    .where(
      and(
        eq(feedback.feedItemId, item.id),
        eq(feedback.profileId, q.profileId),
        inArray(feedback.kind, ["like", "dislike", "clear"]),
      ),
    )
    .orderBy(desc(feedback.id))
    .limit(1);
  const kind = last?.kind === q.kind ? "clear" : q.kind;
  const [row] = await db
    .insert(feedback)
    .values({
      profileId: q.profileId,
      feedItemId: item.id,
      deliveryId: delivery?.id ?? null,
      channel: WEB_FEEDBACK_CHANNEL,
      recipient: `profile:${q.profileId}`,
      kind,
    })
    .returning({ id: feedback.id });
  if (!row) throw new Error("không ghi được phản hồi");
  return { ok: true, feedbackId: row.id, state: kind === "clear" ? "none" : kind };
}
