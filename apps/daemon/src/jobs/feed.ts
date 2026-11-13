/**
 * Daily feed snapshot (decision 10/11/2026, mo-hinh-de-xuat.html: "the web feed is the main source,
 * Telegram is only the notification channel"):
 *
 *    1. At 07:00 VN, ONE snapshot per (profile, slot): `select` runs once with cap K =
 *       `feedMaxItems`, per-source cap `feedMaxPerSource`, feed floor; slot reservation, MMR and Gumbel top-k unchanged.
 *    2. The crypto seed is saved to the `feed_snapshots` row RIGHT when the row is created, before selecting; if the process
 *       crashes midway, the next run reselects with exactly that seed. If already `ready`, reuse it, do not rebuild.
 *    3. The notification layer (the first ≤ 7 items by position, per-source cap 5, `pickNotify`; no floor of its own) only MARKS items in the snapshot
 *       (`notify_position`), it does not change the snapshot.
 */
import {
  createLogger,
  type DecisionProvider,
  type HttpClient,
  type LlmProvider,
  pickNotify,
} from "@radard/core";
import {
  type Database,
  type FeedItem,
  type FeedSnapshot,
  feedItems,
  feedSnapshots,
  profile,
  snapshotIntroMeta,
} from "@radard/db";
import { and, asc, eq } from "drizzle-orm";
import { recordCandidatePoolSafely } from "./candidate-pool.ts";
import type { GateCounts, GateDecision } from "./gate-decision.ts";
import { type RankResult, rankPeriod } from "./rank.ts";
import {
  computeSelectionLearning,
  newSelectSeed,
  notifyRuleOf,
  type SelectionLearning,
} from "./selection-learning.ts";
import { generateIntro } from "./snapshot-intro.ts";
import { ensureSharedSummaries } from "./summaries.ts";

const log = createLogger("feed");
const DAY_MS = 86_400_000;

/** Ranking info stored with the snapshot and the digest plan, to explain why items were chosen. */
export interface RankingInfo {
  candidates: number;
  passedGate: number;
  rejected: Record<string, number>;
  config: Record<string, unknown>;
  baselines: RankResult["baselines"];
  /** Time of the whole ranking step, in milliseconds (absent in plans before 16/10/2026). */
  ms?: number;
  /**
   * Decision-model gate for events with R in the grey zone: counts, each event checked
   * (R, topic, probability, passed or not, whether the old rule was used) and the time spent asking. Absent in plans
   * before 16/10/2026.
   */
  decision?: {
    model: string | null;
    counts: GateCounts;
    ms: number;
    events: GateDecision[];
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Config in JSON form (priors is a Map → object). */
function configJson(cfg: RankResult["config"]): Record<string, unknown> {
  const { priors, ...rest } = cfg;
  return { ...rest, priors: Object.fromEntries(priors) };
}

export function rankingInfo(
  rank: RankResult,
  ms: number,
  decider: DecisionProvider | null | undefined,
): RankingInfo {
  const rejected: Record<string, number> = {};
  for (const x of rank.rejected) rejected[x.reason] = (rejected[x.reason] ?? 0) + 1;
  return {
    candidates: rank.candidates,
    passedGate: rank.passedGate,
    rejected,
    config: configJson(rank.config),
    baselines: rank.baselines,
    ms,
    decision: {
      model: decider?.model ?? null,
      counts: rank.gateCounts,
      ms: rank.gateMs,
      events: rank.gateDecisions.map((d) => ({
        ...d,
        R: round3(d.R),
        probability: d.probability === null ? null : round3(d.probability),
      })),
    },
  };
}

/** One snapshot item before writing (also the shape buildPlan uses for previews). */
export type FeedItemDraft = Omit<
  typeof feedItems.$inferInsert,
  "id" | "snapshotId" | "createdAt"
> & {
  position: number;
  eventId: number;
  documentIds: number[];
  topicId: number | null;
  notifyPosition: number | null;
};

/**
 * Ordered list of the snapshot from the ranking result: positions 1..n in the order `select` returns
 * (S minus the penalty, descending); notified items are marked `notifyPosition` 1..7 by `pickNotify`.
 */
export function feedItemsOf(rank: RankResult, profileId: number): FeedItemDraft[] {
  const items = rank.picked.map(
    (p, i): FeedItemDraft => ({
      profileId,
      position: i + 1,
      eventId: p.event.eventId,
      documentIds: p.event.docs.map((d) => d.documentId),
      sourceId: p.c.sourceId,
      topicId: p.c.topicId,
      title: p.event.title,
      score: p.S,
      penalty: p.penalty,
      r: p.c.R,
      p: p.c.P,
      c: p.c.C,
      a: p.c.A,
      f: p.c.F,
      u: p.c.U,
      n: p.c.N,
      reserved: p.reserved,
      notifyPosition: null,
    }),
  );
  const notified = pickNotify(items, notifyRuleOf(rank));
  for (const [i, n] of notified.entries()) {
    const it = items[n.position - 1];
    if (it) it.notifyPosition = i + 1;
  }
  return items;
}

/** The notified items of the snapshot, in notification order. */
export function notifiedItems<T extends { notifyPosition: number | null }>(
  items: readonly T[],
): T[] {
  return items
    .filter((it) => it.notifyPosition !== null)
    .sort((a, b) => (a.notifyPosition ?? 0) - (b.notifyPosition ?? 0));
}

export interface FeedDeps {
  db: Database;
  profileId: number;
  http?: HttpClient;
  decider?: DecisionProvider | null;
  /**
   * Shared summary model (`event_summaries`) for ALL items of the snapshot. If absent (or on error), the
   * item has no `summary_id` and shows the original title; it does not block the snapshot.
   */
  llm?: LlmProvider | null;
  /** Computes the learning data after selection (default `computeSelectionLearning`); only replaced in tests. */
  computeLearning?: (rank: RankResult) => SelectionLearning | null;
}

export interface FeedSnapshotResult {
  snapshot: FeedSnapshot;
  items: FeedItem[];
  /** `true`: this run builds the snapshot; `false`: reuse the saved one. */
  built: boolean;
}

/** Ranking info saved in the snapshot. */
export function snapshotRanking(s: FeedSnapshot): RankingInfo | null {
  return (s.meta.ranking as RankingInfo | undefined) ?? null;
}

/** Learning data saved in the snapshot (null when absent). */
export function snapshotLearning(s: FeedSnapshot): SelectionLearning | null {
  return (s.meta.learning as SelectionLearning | undefined) ?? null;
}

async function loadItems(db: Database, s: FeedSnapshot): Promise<FeedItem[]> {
  return db
    .select()
    .from(feedItems)
    .where(and(eq(feedItems.snapshotId, s.id), eq(feedItems.profileId, s.profileId)))
    .orderBy(asc(feedItems.position));
}

/**
 * Ensures a shared summary exists for ALL items of the snapshot (decision 11/11/2026) and writes `summary_id`
 * to each item: the summary is exactly as it was when the snapshot was built, stable even if the event later gains articles. Any error
 * only leaves items without a summary; it does not block the snapshot.
 */
async function attachSharedSummaries(
  deps: FeedDeps,
  drafts: FeedItemDraft[],
): Promise<Map<number, { title: string }>> {
  try {
    const [prof] = await deps.db
      .select({ lang: profile.displayLang })
      .from(profile)
      .where(eq(profile.id, deps.profileId));
    const res = await ensureSharedSummaries(
      { db: deps.db, llm: deps.llm ?? null },
      drafts,
      prof?.lang ?? "vi",
    );
    for (const d of drafts) d.summaryId = res.byEvent.get(d.eventId)?.id ?? null;
    log.info("tóm tắt chung của bản chụp", {
      profileId: deps.profileId,
      items: drafts.length,
      requested: res.requested,
      failed: res.failed,
    });
    return res.byEvent;
  } catch (err) {
    log.error("tóm tắt chung lỗi, bản chụp không có tóm tắt", {
      profileId: deps.profileId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return new Map();
  }
}

/**
 * The opening paragraph of the snapshot (once per snapshot, from the top items' titles in position order). Never throws:
 * a failure returns null and the snapshot is built without an intro.
 */
async function snapshotIntro(
  deps: FeedDeps,
  drafts: readonly FeedItemDraft[],
  summaries: ReadonlyMap<number, { title: string }>,
): Promise<string | null> {
  try {
    const [prof] = await deps.db
      .select({ lang: profile.displayLang, context: profile.promptContext })
      .from(profile)
      .where(eq(profile.id, deps.profileId));
    return await generateIntro(deps.llm ?? null, {
      context: prof?.context ?? "",
      lang: prof?.lang ?? "vi",
      titles: [...drafts]
        .sort((a, b) => a.position - b.position)
        .map((d) => summaries.get(d.eventId)?.title ?? d.title),
    });
  } catch (err) {
    log.error("lời mở đầu lỗi, bản chụp không có lời mở đầu", {
      profileId: deps.profileId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return null;
  }
}

/**
 * The feed snapshot of (profile, `slot`): if already `ready`, read it back; if not, build it with the seed
 * saved in the row (create the row and seed if not yet there), write the list and mark `ready` in ONE transaction.
 * If two processes build at once, the one that writes later sees `ready`, discards its own result and reads the saved one.
 */
export async function ensureFeedSnapshot(deps: FeedDeps, slot: Date): Promise<FeedSnapshotResult> {
  const { db, profileId } = deps;
  const key = and(eq(feedSnapshots.profileId, profileId), eq(feedSnapshots.periodEnd, slot));
  await db
    .insert(feedSnapshots)
    .values({
      profileId,
      periodStart: new Date(slot.getTime() - DAY_MS),
      periodEnd: slot,
      selectSeed: newSelectSeed(),
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(feedSnapshots).where(key);
  if (!row) throw new Error("không tạo được dòng feed_snapshots");
  if (row.status === "ready")
    return { snapshot: row, items: await loadItems(db, row), built: false };

  const period = { start: row.periodStart, end: row.periodEnd };
  const started = Date.now();
  const rank = await rankPeriod(db, period, {
    profileId,
    http: deps.http,
    decider: deps.decider,
    selectSeed: row.selectSeed,
  });
  const rankMs = Date.now() - started;
  // Candidate pool: write errors are swallowed, they do not block the snapshot.
  await recordCandidatePoolSafely(db, profileId, rank);
  let learning: SelectionLearning | null = null;
  try {
    learning = (deps.computeLearning ?? computeSelectionLearning)(rank);
  } catch (err) {
    log.warn("mô phỏng xác suất chọn lỗi, bỏ dữ liệu học của ngày này", {
      snapshotId: row.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
  const drafts = feedItemsOf(rank, profileId);
  const summaries = await attachSharedSummaries(deps, drafts);
  // Reuse an intro already in the row (never calls the model twice for one snapshot).
  const intro = snapshotIntroMeta(row).intro ?? (await snapshotIntro(deps, drafts, summaries));

  const built = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(feedSnapshots).where(key).for("update");
    if (!locked) throw new Error("dòng feed_snapshots biến mất");
    if (locked.status === "ready") return false;
    // A previous run that crashed midway left no items (same transaction), but delete them anyway to be safe.
    await tx.delete(feedItems).where(eq(feedItems.snapshotId, locked.id));
    for (let i = 0; i < drafts.length; i += 200) {
      await tx
        .insert(feedItems)
        .values(drafts.slice(i, i + 200).map((d) => ({ ...d, snapshotId: locked.id })));
    }
    await tx
      .update(feedSnapshots)
      .set({
        status: "ready",
        itemCount: drafts.length,
        feedFloor: rank.feedFloor.value,
        config: configJson(rank.selectConfig),
        meta: {
          ...locked.meta,
          floors: { feed: rank.feedFloor },
          ranking: rankingInfo(rank, rankMs, deps.decider),
          // Events of the 24h window in the profile's topics (passed the topic gate): the "132" in the digest.
          eventCount: rank.passedGate,
          ...(intro ? { intro } : {}),
          ...(learning ? { learning } : {}),
        },
        builtAt: new Date(),
      })
      .where(eq(feedSnapshots.id, locked.id));
    return true;
  });
  const [saved] = await db.select().from(feedSnapshots).where(key);
  if (!saved) throw new Error("không đọc lại được feed_snapshots");
  const items = await loadItems(db, saved);
  log.info(built ? "đã dựng bản chụp feed" : "bản chụp đã có từ lượt khác", {
    profileId,
    snapshotId: saved.id,
    items: items.length,
    notify: notifiedItems(items).length,
  });
  return { snapshot: saved, items, built };
}
