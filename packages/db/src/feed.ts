/**
 * Read/write feed for the web role (HTTP endpoints built by the web part). Every function takes the `profileId` of the
 * logged-in user and FILTERS by it: no function reads or writes another profile's data (fail-closed).
 * Invalid input (another profile's snapshot, a non-existent position) writes nothing.
 *
 * Snapshots are built by the daemon (apps/daemon/src/jobs/feed.ts); here we only read `ready` ones.
 */
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { documents, sources } from "./schema/collected.ts";
import { deliveries, feedback } from "./schema/delivery.ts";
import { feedImpressions, feedItems, feedSnapshots } from "./schema/feed.ts";
import { topics } from "./schema/profile.ts";
import { eventSummaries } from "./schema/summaries.ts";

export type FeedSnapshot = typeof feedSnapshots.$inferSelect;
export type FeedItem = typeof feedItems.$inferSelect;

/** The latest `ready` snapshot of the profile (or of the exact `periodEnd` window), `null` if none. */
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
 * One page of the snapshot by position cursor: items with position > `after`, up to `limit`. A snapshot
 * not belonging to the profile returns empty. `done` = all K items of the snapshot have been served ("no more items today").
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
 * Writes a batch of impressions. Check before writing: every (snapshot, position) must be a real item of the snapshot
 * belonging to `profileId`; if ONE entry is wrong, nothing is written and the wrong entries are returned. Idempotent: (snapshot, position)
 * that already has an impression is skipped, keeping the first `seen_at`. `seen_at` is server time (not
 * the browser's clock). The composite foreign key (profile_id, snapshot_id, position) blocks it once more in the DB.
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
  /** Number of items in the snapshot (K of that day). */
  itemCount: number;
  /** Largest position shown; 0 when that day has no impressions. */
  deepestPosition: number;
  /** Scrolled through the whole snapshot: data is capped (we do not know how much more the user wants to read). */
  censored: boolean;
}

/**
 * Maximum scroll depth per day (each `ready` snapshot with `period_end` in [from, to)) of the profile, oldest
 * to newest. Data for estimating h of θk = (1 − h)^(k−1) later; not used anywhere yet.
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

/** Channel written to `feedback.channel` for feedback from the web. */
export const WEB_FEEDBACK_CHANNEL = "web";

export type FeedFeedbackResult =
  | { ok: true; feedbackId: number; state: "like" | "dislike" | "none" }
  | { ok: false; reason: "not_found" };

/**
 * 👍/👎 feedback from the web on a feed item. Same convention as Telegram feedback (jobs/feedback.ts):
 * append only; pressing the same button again clears it (a `clear` row). The current opinion on an item is the row
 * with the latest `feed_item_id`, whether it came from Telegram or the web. An item not belonging to `profileId` gives
 * `not_found`, and nothing is written. For an item sent via Telegram, the new row also carries that item's `delivery_id`,
 * so the existing per-delivery feedback reader (taste clusters) also sees the web feedback.
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

// ---------------------------------------------------------------------------------------------
// Reads for the /api/feed route (every function requires `profileId` and filters by it)
// ---------------------------------------------------------------------------------------------

export type FeedbackState = "like" | "dislike" | "none";

/** VN date (YYYY-MM-DD) of a moment. */
export function vnDate(d: Date): string {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

const vnDateSql = (col: typeof feedSnapshots.periodEnd) =>
  sql<string>`to_char(${col} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;

/**
 * The `ready` snapshot of the profile whose `period_end` falls on VN date `date` (YYYY-MM-DD); `null` if none.
 * A `date` that is not a real day (e.g. 2026-02-31) is also `null`.
 */
export async function feedSnapshotOnDate(
  db: Database,
  profileId: number,
  date: string,
): Promise<FeedSnapshot | null> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) return null;
  const [row] = await db
    .select()
    .from(feedSnapshots)
    .where(
      and(
        eq(feedSnapshots.profileId, profileId),
        eq(feedSnapshots.status, "ready"),
        sql`${vnDateSql(feedSnapshots.periodEnd)} = ${date}`,
      ),
    )
    .orderBy(desc(feedSnapshots.periodEnd))
    .limit(1);
  return row ?? null;
}

/** Days that have a `ready` snapshot of the profile, newest first. */
export async function feedDates(
  db: Database,
  q: { profileId: number; limit?: number },
): Promise<{ date: string; snapshotId: number; itemCount: number }[]> {
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 60);
  const rows = await db
    .select({
      date: vnDateSql(feedSnapshots.periodEnd),
      snapshotId: feedSnapshots.id,
      itemCount: feedSnapshots.itemCount,
    })
    .from(feedSnapshots)
    .where(and(eq(feedSnapshots.profileId, q.profileId), eq(feedSnapshots.status, "ready")))
    .orderBy(desc(feedSnapshots.periodEnd))
    .limit(limit);
  return rows.map((r) => ({ date: r.date, snapshotId: r.snapshotId, itemCount: r.itemCount ?? 0 }));
}

/**
 * Current feedback state of the profile for items: the latest row (like/dislike/clear) of each
 * `feed_item_id`, regardless of channel (same convention as `recordFeedFeedback`). No row gives `none`.
 */
export async function feedbackStates(
  db: Database,
  profileId: number,
  feedItemIds: readonly number[],
): Promise<Map<number, FeedbackState>> {
  const out = new Map<number, FeedbackState>();
  if (feedItemIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([feedback.feedItemId], {
      feedItemId: feedback.feedItemId,
      kind: feedback.kind,
    })
    .from(feedback)
    .where(
      and(
        eq(feedback.profileId, profileId),
        inArray(feedback.feedItemId, [...feedItemIds]),
        inArray(feedback.kind, ["like", "dislike", "clear"]),
      ),
    )
    .orderBy(feedback.feedItemId, desc(feedback.id));
  for (const r of rows) {
    if (r.feedItemId !== null)
      out.set(r.feedItemId, r.kind === "clear" ? "none" : (r.kind as "like" | "dislike"));
  }
  return out;
}

export interface FeedItemView {
  position: number;
  feedItemId: number;
  eventId: number;
  title: string;
  summary: string | null;
  topic: string | null;
  /** Number of distinct source names (= sources.length). */
  sourceCount: number;
  /** Number of distinct articles (distinct url_canonical). */
  articleCount: number;
  sources: string[];
  updated: boolean;
  inDigest: boolean;
  notifyPosition: number | null;
  feedback: FeedbackState;
  score: { s: number; r: number; p: number; c: number; a: number; f: number; u: number; n: number };
}

/** Topic name and shared summary of feed rows (accepts only rows already filtered by profile). */
async function decorate(
  db: Database,
  profileId: number,
  rows: readonly FeedItem[],
): Promise<FeedItemView[]> {
  if (rows.length === 0) return [];
  const topicIds = [...new Set(rows.flatMap((r) => (r.topicId === null ? [] : [r.topicId])))];
  const summaryIds = [...new Set(rows.flatMap((r) => (r.summaryId === null ? [] : [r.summaryId])))];
  const docIds = [...new Set(rows.flatMap((r) => r.documentIds))];
  const [topicRows, summaryRows, docRows, states] = await Promise.all([
    topicIds.length
      ? db
          .select({ id: topics.id, name: topics.name })
          .from(topics)
          .where(inArray(topics.id, topicIds))
      : [],
    summaryIds.length
      ? db
          .select({ id: eventSummaries.id, summary: eventSummaries.summary })
          .from(eventSummaries)
          .where(inArray(eventSummaries.id, summaryIds))
      : [],
    docIds.length
      ? db
          .select({
            id: documents.id,
            urlCanonical: documents.urlCanonical,
            sourceName: sources.name,
          })
          .from(documents)
          .innerJoin(sources, eq(sources.id, documents.sourceId))
          .where(inArray(documents.id, docIds))
      : [],
    feedbackStates(
      db,
      profileId,
      rows.map((r) => r.id),
    ),
  ]);
  const topicName = new Map(topicRows.map((t) => [t.id, t.name]));
  const summaryText = new Map(summaryRows.map((s) => [s.id, s.summary]));
  const docById = new Map(docRows.map((d) => [d.id, d]));
  return rows.map((r) => {
    const docs = r.documentIds.flatMap((id) => docById.get(id) ?? []);
    return {
      position: r.position,
      feedItemId: r.id,
      eventId: r.eventId,
      title: r.title,
      summary: r.summaryId === null ? null : (summaryText.get(r.summaryId) ?? null),
      topic: r.topicId === null ? null : (topicName.get(r.topicId) ?? null),
      sourceCount: new Set(docs.map((d) => d.sourceName)).size,
      articleCount: new Set(docs.map((d) => d.urlCanonical)).size,
      sources: [...new Set(docs.map((d) => d.sourceName))],
      updated: r.n < 1,
      inDigest: r.notifyPosition !== null,
      notifyPosition: r.notifyPosition,
      feedback: states.get(r.id) ?? "none",
      score: { s: r.score, r: r.r, p: r.p, c: r.c, a: r.a, f: r.f, u: r.u, n: r.n },
    };
  });
}

/**
 * One page of items of the snapshot to show: `feedPage` (profile-filtered) with the shared summary, topic label, name
 * of source and current feedback. A snapshot not belonging to the profile is empty.
 */
export async function feedItemsView(
  db: Database,
  q: { profileId: number; snapshotId: number; after?: number; limit?: number },
): Promise<{ items: FeedItemView[]; nextAfter: number | null; done: boolean }> {
  const page = await feedPage(db, q);
  return {
    items: await decorate(db, q.profileId, page.items),
    nextAfter: page.nextAfter,
    done: page.done,
  };
}

/**
 * The LATEST feed item of the profile for an event (with fields like `feedItemsView`) and the
 * captured `documentIds`; `null` if the event is not in the profile's feed.
 */
export async function feedItemForEvent(
  db: Database,
  q: { profileId: number; eventId: number },
): Promise<{ view: FeedItemView; row: FeedItem } | null> {
  const [row] = await db
    .select()
    .from(feedItems)
    .where(and(eq(feedItems.profileId, q.profileId), eq(feedItems.eventId, q.eventId)))
    .orderBy(desc(feedItems.id))
    .limit(1);
  if (!row) return null;
  const [view] = await decorate(db, q.profileId, [row]);
  return view ? { view, row } : null;
}
