/**
 * Bản chụp feed mỗi ngày (quyết định 10/11/2026, mo-hinh-de-xuat.html: "feed web là nguồn chính,
 * Telegram chỉ là kênh thông báo"):
 *
 *   1. Lúc 07:00 VN, MỘT bản chụp cho mỗi (hồ sơ, khung): `select` chạy một lần với trần K =
 *      `feedMaxItems`, mỗi nguồn `feedMaxPerSource`, sàn feed; giữ chỗ, MMR, Gumbel top-k giữ nguyên.
 *   2. Hạt giống crypto lưu vào dòng `feed_snapshots` NGAY khi tạo dòng, trước khi chọn; chết giữa
 *      chừng thì lượt sau chọn lại với đúng hạt đó. Đã `ready` thì dùng lại, không dựng lại.
 *   3. Lớp thông báo (≤ 7 tin đầu qua sàn thông báo, `pickNotify`) chỉ ĐÁNH DẤU tin trong bản chụp
 *      (`notify_position`), không đổi bản chụp.
 */
import { createLogger, type DecisionProvider, type HttpClient, pickNotify } from "@radard/core";
import {
  type Database,
  type FeedItem,
  type FeedSnapshot,
  feedItems,
  feedSnapshots,
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

const log = createLogger("feed");
const DAY_MS = 86_400_000;

/** Thông tin xếp hạng lưu kèm bản chụp và plan digest, để giải thích vì sao chọn. */
export interface RankingInfo {
  candidates: number;
  passedGate: number;
  rejected: Record<string, number>;
  config: Record<string, unknown>;
  baselines: RankResult["baselines"];
  /** Thời gian cả bước xếp hạng, mili giây (vắng ở plan trước 16/10/2026). */
  ms?: number;
  /**
   * Cổng bằng model quyết định cho các sự kiện có R trong vùng xám: số đếm, từng sự kiện đã xét
   * (R, chủ đề, xác suất, qua hay không, có dùng luật cũ không) và thời gian hỏi. Vắng ở plan
   * trước 16/10/2026.
   */
  decision?: {
    model: string | null;
    counts: GateCounts;
    ms: number;
    events: GateDecision[];
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Cấu hình dạng JSON (priors là Map → đối tượng). */
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

/** Một tin của bản chụp trước khi ghi (cũng là dạng buildPlan xem thử dùng). */
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
 * Danh sách có thứ tự của bản chụp từ kết quả xếp hạng: vị trí 1..n theo thứ tự `select` trả về
 * (S − phạt giảm dần); tin được báo đánh dấu `notifyPosition` 1..7 theo `pickNotify`.
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
  const notified = pickNotify(
    items.map((it) => ({ ...it, S: it.score })),
    notifyRuleOf(rank),
  );
  for (const [i, n] of notified.entries()) {
    const it = items[n.position - 1];
    if (it) it.notifyPosition = i + 1;
  }
  return items;
}

/** Tin được báo của bản chụp, theo thứ tự báo. */
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
  /** Tính dữ liệu học sau khi chọn (mặc định `computeSelectionLearning`); chỉ test thay. */
  computeLearning?: (rank: RankResult) => SelectionLearning | null;
}

export interface FeedSnapshotResult {
  snapshot: FeedSnapshot;
  items: FeedItem[];
  /** `true`: lượt này dựng bản chụp; `false`: dùng lại bản đã lưu. */
  built: boolean;
}

/** Thông tin xếp hạng đã lưu trong bản chụp. */
export function snapshotRanking(s: FeedSnapshot): RankingInfo | null {
  return (s.meta.ranking as RankingInfo | undefined) ?? null;
}

/** Dữ liệu học đã lưu trong bản chụp (null khi không có). */
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
 * Bản chụp feed của (hồ sơ, khung `slot`): đã `ready` thì đọc lại; chưa thì dựng với hạt giống đã
 * lưu trong dòng (tạo dòng và hạt nếu chưa có), ghi danh sách và đánh dấu `ready` trong MỘT giao dịch.
 * Hai tiến trình cùng dựng: tiến trình ghi sau thấy `ready` thì bỏ kết quả của mình, đọc bản đã lưu.
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
  // Bể ứng viên: lỗi ghi bị nuốt, không chặn bản chụp.
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

  const built = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(feedSnapshots).where(key).for("update");
    if (!locked) throw new Error("dòng feed_snapshots biến mất");
    if (locked.status === "ready") return false;
    // Lượt trước chết giữa chừng không để lại tin (cùng giao dịch), nhưng xoá cho chắc.
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
        notifyFloor: rank.floor.value,
        config: configJson(rank.selectConfig),
        meta: {
          ...locked.meta,
          floors: { feed: rank.feedFloor, notify: rank.floor },
          ranking: rankingInfo(rank, rankMs, deps.decider),
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
