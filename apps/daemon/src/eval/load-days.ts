/**
 * Đọc dữ liệu cho bộ chấm bất biến (a) từ DB. Hai lớp tách riêng:
 *   1. các câu truy vấn (`queryDeliveries`, `queryLatestFeedback`, `queryUrls`) trả dòng thô;
 *   2. `buildDays` dựng mẫu từ dòng thô, thuần, không chạm DB.
 * Lọc theo hồ sơ/người nhận nằm ở lớp 1 (`EvalFilter`).
 */

import type { EvalDay, EvalSample, Level, StoredScore } from "@radard/core";
import { type Database, deliveries, digests, documents, feedback } from "@radard/db";
import { and, desc, eq, inArray } from "drizzle-orm";

/** Bộ lọc tuỳ chọn; để trống = mọi người nhận. */
export interface EvalFilter {
  /** Chỉ lấy tin của hồ sơ này (`digests.profile_id`). */
  profileId?: number;
  channel?: string;
  recipient?: string;
}

/** Một tin sự kiện đã gửi, kèm plan của digest chứa nó. */
export interface RawDelivery {
  deliveryId: number;
  digestId: number;
  periodEnd: Date;
  position: number;
  documentIds: number[];
  /** `digests.meta` nguyên khối; chỉ `plan.items` được đọc. */
  digestMeta: Record<string, unknown>;
}

export type FeedbackKind = "like" | "dislike" | "clear";

/** Dòng phản hồi MỚI NHẤT của mỗi delivery (chỉ like/dislike/clear). */
export type LatestFeedback = ReadonlyMap<number, FeedbackKind>;

export async function queryDeliveries(
  db: Database,
  filter: EvalFilter = {},
): Promise<RawDelivery[]> {
  const conds = [eq(deliveries.kind, "event")];
  if (filter.profileId !== undefined) conds.push(eq(digests.profileId, filter.profileId));
  if (filter.channel) conds.push(eq(digests.channel, filter.channel));
  if (filter.recipient) conds.push(eq(digests.recipient, filter.recipient));
  const rows = await db
    .select({
      deliveryId: deliveries.id,
      digestId: deliveries.digestId,
      position: deliveries.position,
      documentIds: deliveries.documentIds,
      periodEnd: digests.periodEnd,
      digestMeta: digests.meta,
    })
    .from(deliveries)
    .innerJoin(digests, eq(deliveries.digestId, digests.id))
    .where(and(...conds))
    .orderBy(digests.periodEnd, deliveries.position);
  const out: RawDelivery[] = [];
  for (const r of rows) {
    if (r.digestId === null || r.position === null) continue;
    out.push({
      deliveryId: r.deliveryId,
      digestId: r.digestId,
      position: r.position,
      documentIds: r.documentIds,
      periodEnd: r.periodEnd,
      digestMeta: r.digestMeta,
    });
  }
  return out;
}

/** Dòng mới nhất của mỗi delivery theo (created_at, id lớn hơn thắng); `comment` bị bỏ qua. */
export async function queryLatestFeedback(
  db: Database,
  deliveryIds: readonly number[],
): Promise<LatestFeedback> {
  const out = new Map<number, FeedbackKind>();
  if (deliveryIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([feedback.deliveryId], {
      deliveryId: feedback.deliveryId,
      kind: feedback.kind,
    })
    .from(feedback)
    .where(
      and(
        inArray(feedback.deliveryId, [...deliveryIds]),
        inArray(feedback.kind, ["like", "dislike", "clear"]),
      ),
    )
    .orderBy(feedback.deliveryId, desc(feedback.createdAt), desc(feedback.id));
  for (const r of rows) {
    if (r.deliveryId !== null) out.set(r.deliveryId, r.kind as FeedbackKind);
  }
  return out;
}

/** `documents.id` → `url_canonical`. */
export async function queryUrls(
  db: Database,
  documentIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const out = new Map<number, string>();
  if (documentIds.length === 0) return out;
  const rows = await db
    .select({ id: documents.id, url: documents.urlCanonical })
    .from(documents)
    .where(inArray(documents.id, [...documentIds]));
  for (const r of rows) out.set(r.id, r.url);
  return out;
}

const VN_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Ngày YYYY-MM-DD của một thời điểm theo giờ Việt Nam. */
export const vnDay = (d: Date): string => VN_DAY.format(d);

export function levelOf(kind: FeedbackKind | undefined): Level {
  return kind === "like" ? "like" : kind === "dislike" ? "dislike" : "none";
}

const SCORE_KEYS = ["S", "penalty", "R", "P", "C", "A", "F", "N"] as const;

function storedScore(x: unknown): StoredScore | null {
  if (typeof x !== "object" || x === null) return null;
  const rec = x as Record<string, unknown>;
  const out = {} as StoredScore;
  for (const k of SCORE_KEYS) {
    const v = rec[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

/** `position` → điểm đã lưu của các item trong plan. */
function planScores(meta: Record<string, unknown>): Map<number, StoredScore> {
  const out = new Map<number, StoredScore>();
  const plan = meta.plan;
  const items =
    typeof plan === "object" && plan !== null ? (plan as { items?: unknown }).items : null;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const { position, score } = it as { position?: unknown; score?: unknown };
    const s = storedScore(score);
    if (typeof position === "number" && s) out.set(position, s);
  }
  return out;
}

export interface BuiltDays {
  days: EvalDay[];
  /** Tin bị bỏ vì plan không có item/điểm tương ứng (plan cũ hoặc hỏng). */
  skipped: number;
}

/** Dựng các ngày từ dòng thô. Thuần: không chạm DB. */
export function buildDays(
  rows: readonly RawDelivery[],
  latest: LatestFeedback,
  urlOf: ReadonlyMap<number, string>,
): BuiltDays {
  const byDate = new Map<string, EvalSample[]>();
  const plans = new Map<number, Map<number, StoredScore>>();
  let skipped = 0;
  for (const r of rows) {
    let scores = plans.get(r.digestId);
    if (!scores) {
      scores = planScores(r.digestMeta);
      plans.set(r.digestId, scores);
    }
    const score = scores.get(r.position);
    if (!score) {
      skipped++;
      continue;
    }
    const date = vnDay(r.periodEnd);
    const urls = [
      ...new Set(r.documentIds.map((id) => urlOf.get(id)).filter((u): u is string => !!u)),
    ].sort();
    const sample: EvalSample = {
      date,
      position: r.position,
      urls,
      level: levelOf(latest.get(r.deliveryId)),
      score,
    };
    const list = byDate.get(date);
    if (list) list.push(sample);
    else byDate.set(date, [sample]);
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, samples]) => ({ date, samples }));
  return { days, skipped };
}

/** Đọc DB rồi dựng các ngày. */
export async function loadDays(db: Database, filter: EvalFilter = {}): Promise<BuiltDays> {
  const rows = await queryDeliveries(db, filter);
  const latest = await queryLatestFeedback(
    db,
    rows.map((r) => r.deliveryId),
  );
  const urlOf = await queryUrls(db, [...new Set(rows.flatMap((r) => r.documentIds))]);
  return buildDays(rows, latest, urlOf);
}
