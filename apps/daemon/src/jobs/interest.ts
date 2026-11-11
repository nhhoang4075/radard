/**
 * Clusters the user's taste from 👍 items in the DB (pure core: packages/core/src/interest.ts) and stores the cluster set of this run.
 *
 * - An item's label is the LATEST feedback of that delivery (`like`, `dislike`, `clear`; a text
 *   `comment` is not a label). Only `like` goes into a cluster; `clear` and `dislike` do not.
 * - Item vector: the document vector `coalesce(content_embedding, embedding)` of the first document
 *   with a vector in `deliveries.document_ids`, L2-normalized.
 * - Each call re-clusters from scratch. A new cluster borrows the name of the previous run's cluster (table `interest_clusters`) by nearest
 *   centroid. Age is measured from `now` (the `end` of the ranking window), so re-running an old day gives exactly that day's result;
 *   feedback after `now` is ignored.
 * - No 👎 clusters yet (TODO(spec: ~30 👎)).
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

/** The 👍 items of the profile before the `now` cutoff (the latest label of each delivery is `like`), with their vectors. */
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

/** The saved cluster set of the previous run (in rank order). */
export async function loadStoredClusters(db: Database, profileId: number) {
  const rows = await db
    .select()
    .from(interestClusters)
    .where(eq(interestClusters.profileId, profileId))
    .orderBy(interestClusters.position);
  return rows.map((r) => ({ name: r.name, center: r.center }));
}

/** Replaces the whole cluster set of the profile with the new set, in one transaction. */
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
 * Re-clusters the profile's 👍 items from scratch at cutoff `now`; `persist` saves the cluster set as "yesterday's clusters"
 * for the next run. Read/write errors must not block ranking: log them and treat it as no clusters (U = 0).
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
