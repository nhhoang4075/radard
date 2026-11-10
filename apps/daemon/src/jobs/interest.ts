/**
 * Gom cụm gu từ tin 👍 trên DB (lõi thuần: packages/core/src/interest.ts) và lưu bộ cụm của lần chạy.
 *
 * - Nhãn của một tin là phản hồi MỚI NHẤT của delivery đó (`like`, `dislike`, `clear`; nhận xét
 *   `comment` không phải nhãn). Chỉ `like` vào cụm; `clear` và `dislike` thì không.
 * - Vector của tin: vector cả tài liệu `coalesce(content_embedding, embedding)` của tài liệu đầu
 *   tiên có vector trong `deliveries.document_ids`, chuẩn hoá L2.
 * - Mỗi lần gọi gom lại từ đầu. Cụm mới mượn tên cụm lần trước (bảng `interest_clusters`) theo tâm
 *   gần nhất. Tuổi tính từ `now` (mốc `end` của khoảng xếp hạng), chạy lại ngày cũ ra đúng kết quả
 *   ngày đó; phản hồi sau `now` bị bỏ.
 * - Chưa có cụm 👎 (TODO(spec: ~30 👎)).
 */
import {
  clusterInterests,
  createLogger,
  type InterestCluster,
  type InterestItem,
  type RankConfig,
} from "@radard/core";
import { type Database, interestClusters } from "@radard/db";
import { eq, sql } from "drizzle-orm";

const log = createLogger("interest");
const DAY_MS = 86_400_000;

function l2(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** Các tin 👍 (nhãn mới nhất của mỗi delivery là `like`) của hồ sơ trước mốc `now`, kèm vector. */
export async function loadLikedItems(
  db: Database,
  profileId: number,
  now: Date,
): Promise<InterestItem[]> {
  const likes = await db.execute<{ delivery_id: number; at: Date; document_ids: number[] }>(sql`
    select delivery_id, at, document_ids from (
      select distinct on (f.delivery_id)
        f.delivery_id, f.kind, f.created_at as at, d.document_ids
      from feedback f join deliveries d on d.id = f.delivery_id
      where f.profile_id = ${profileId} and d.profile_id = ${profileId} and d.kind = 'event'
        and f.kind in ('like', 'dislike', 'clear') and f.created_at < ${now}
      order by f.delivery_id, f.created_at desc, f.id desc
    ) latest
    where kind = 'like'`);
  if (likes.length === 0) return [];
  const docIds = [...new Set(likes.flatMap((r) => r.document_ids))];
  if (docIds.length === 0) return [];
  const vecs = new Map<number, number[]>();
  for (const r of await db.execute<{ id: number; vec: string }>(sql`
    select document_id as id, coalesce(content_embedding, embedding)::text as vec
    from doc_text where document_id = any(${`{${docIds.join(",")}}`}::bigint[])`)) {
    vecs.set(Number(r.id), JSON.parse(r.vec) as number[]);
  }
  const items: InterestItem[] = [];
  for (const r of likes) {
    const docId = r.document_ids.find((i: number) => vecs.has(Number(i)));
    if (docId === undefined) continue;
    items.push({
      id: `d${r.delivery_id}`,
      vector: l2(vecs.get(Number(docId)) as number[]),
      ageDays: (now.getTime() - new Date(r.at).getTime()) / DAY_MS,
    });
  }
  return items;
}

/** Bộ cụm đã lưu của lần chạy trước (theo thứ hạng). */
export async function loadStoredClusters(db: Database, profileId: number) {
  const rows = await db
    .select()
    .from(interestClusters)
    .where(eq(interestClusters.profileId, profileId))
    .orderBy(interestClusters.position);
  return rows.map((r) => ({ name: r.name, center: r.center }));
}

/** Thay cả bộ cụm của hồ sơ bằng bộ mới, trong một giao dịch. */
export async function storeClusters(
  db: Database,
  profileId: number,
  clusters: readonly InterestCluster[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(interestClusters).where(eq(interestClusters.profileId, profileId));
    if (clusters.length === 0) return;
    await tx.insert(interestClusters).values(
      clusters.map((c, position) => ({
        profileId,
        position,
        status: c.status,
        name: c.name,
        center: c.center,
        importance: c.importance,
        medoid: c.medoid,
        memberIds: c.memberIds,
      })),
    );
  });
}

/**
 * Gom lại từ đầu các tin 👍 của hồ sơ tại mốc `now`; `persist` thì lưu bộ cụm làm "cụm hôm qua"
 * cho lần sau. Lỗi đọc/ghi không được chặn việc xếp hạng: log rồi coi như không có cụm (U = 0).
 */
export async function computeInterestClusters(
  db: Database,
  profileId: number,
  now: Date,
  cfg: RankConfig["interest"],
  opts: { persist: boolean },
): Promise<InterestCluster[]> {
  try {
    const items = await loadLikedItems(db, profileId, now);
    const previous = await loadStoredClusters(db, profileId);
    const clusters = clusterInterests(items, {
      distanceThreshold: cfg.distanceThreshold,
      maxClusters: cfg.maxClusters,
      minMembers: cfg.minMembers,
      halfLifeDays: cfg.halfLifeDays,
      dropBelowWeight: cfg.dropBelowWeight,
      previous,
      nameCarryMinCosine: cfg.nameCarryMinCosine,
    });
    if (opts.persist) await storeClusters(db, profileId, clusters);
    log.info("gom cụm gu", {
      profileId,
      likes: items.length,
      clusters: clusters.length,
      active: clusters.filter((c) => c.status === "active").length,
    });
    return clusters;
  } catch (err) {
    log.warn("không gom được cụm gu, U = 0", {
      profileId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return [];
  }
}
