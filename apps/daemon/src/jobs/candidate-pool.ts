/**
 * Candidate pool: records every event that passed the gate in one ranking run, with its score components and whether
 * it was selected (table `candidate_pool`). APPEND-ONLY in effect: it does not change how items are selected.
 *
 * This data is for computing the percentile floor later; the send plan keeps only the scores of the selected items.
 */
import { type Components, createLogger } from "@radard/core";
import { candidatePool, type Database } from "@radard/db";
import { and, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import type { RankResult } from "./rank.ts";

const log = createLogger("candidate-pool");

type Row = typeof candidatePool.$inferInsert;

interface Candidate {
  event: { eventId: number; docs: readonly { urlCanonical: string }[] };
  c: Components;
  S: number;
}

function rowOf(
  profileId: number,
  period: RankResult["period"],
  x: Candidate,
  state: { selected: true; penalty: number } | { selected: false; reason: string },
): Row {
  return {
    profileId,
    periodStart: period.start,
    periodEnd: period.end,
    eventId: x.event.eventId,
    urlCanonicals: [...new Set(x.event.docs.map((d) => d.urlCanonical))].sort(),
    sourceId: x.c.sourceId,
    r: x.c.R,
    p: x.c.P,
    c: x.c.C,
    a: x.c.A,
    f: x.c.F,
    n: x.c.N,
    u: x.c.U,
    score: x.S,
    penalty: state.selected ? state.penalty : null,
    selected: state.selected,
    rejectReason: state.selected ? null : state.reason,
  };
}

/**
 * Rows of the pool: the selected items and every item that passed the gate but was dropped afterwards (floor, already sent with
 * nothing new, source cap, no room). Items dropped by the gate are not in the pool.
 */
export function poolRows(profileId: number, rank: RankResult): Row[] {
  const rows = rank.picked.map((p) =>
    rowOf(profileId, rank.period, p, { selected: true, penalty: p.penalty }),
  );
  for (const r of rank.rejected) {
    if (r.reason === "gate" || r.reason === "decision_reject") continue;
    rows.push(rowOf(profileId, rank.period, r, { selected: false, reason: r.reason }));
  }
  return rows;
}

const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/**
 * Writes the pool of one ranking run. Re-running the same range updates the old rows and deletes rows no longer
 * in the new result, so nothing is duplicated. Throws if the write fails; the send flow uses
 * `recordCandidatePoolSafely`.
 */
export async function recordCandidatePool(
  db: Database,
  profileId: number,
  rank: RankResult,
): Promise<number> {
  const rows = poolRows(profileId, rank);
  await db.transaction(async (tx) => {
    const scope = and(
      eq(candidatePool.profileId, profileId),
      eq(candidatePool.periodEnd, rank.period.end),
    );
    const ids = rows.map((r) => r.eventId);
    await tx
      .delete(candidatePool)
      .where(ids.length ? and(scope, notInArray(candidatePool.eventId, ids)) : scope);
    // Postgres limits the number of parameters per statement: split into batches.
    for (let i = 0; i < rows.length; i += 200) {
      await tx
        .insert(candidatePool)
        .values(rows.slice(i, i + 200))
        .onConflictDoUpdate({
          target: [candidatePool.profileId, candidatePool.periodEnd, candidatePool.eventId],
          set: {
            periodStart: sql`${excluded("period_start")}`,
            urlCanonicals: sql`${excluded("url_canonicals")}`,
            sourceId: sql`${excluded("source_id")}`,
            r: sql`${excluded("r")}`,
            p: sql`${excluded("p")}`,
            c: sql`${excluded("c")}`,
            a: sql`${excluded("a")}`,
            f: sql`${excluded("f")}`,
            n: sql`${excluded("n")}`,
            u: sql`${excluded("u")}`,
            score: sql`${excluded("score")}`,
            penalty: sql`${excluded("penalty")}`,
            selected: sql`${excluded("selected")}`,
            rejectReason: sql`${excluded("reject_reason")}`,
          },
        });
    }
  });
  return rows.length;
}

/**
 * Decision: writing the pool is a side job and must NOT break or block the sending of items. Errors are logged and
 * swallowed; this ranking run loses its pool data (acceptable: the percentile floor is computed over 30 days).
 * The write runs in its own transaction, separate from every operation of the send flow.
 */
export async function recordCandidatePoolSafely(
  db: Database,
  profileId: number,
  rank: RankResult,
): Promise<void> {
  try {
    const n = await recordCandidatePool(db, profileId, rank);
    log.info("đã ghi bể ứng viên", { profileId, rows: n });
  } catch (err) {
    log.warn("không ghi được bể ứng viên, bỏ qua", {
      profileId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}

export type CandidateScore = typeof candidatePool.$inferSelect;

/** Reads the pool rows with `period_end` in [from, to), by profile, oldest to newest. */
export async function readCandidateScores(
  db: Database,
  q: { profileId: number; from: Date; to: Date },
): Promise<CandidateScore[]> {
  return db
    .select()
    .from(candidatePool)
    .where(
      and(
        eq(candidatePool.profileId, q.profileId),
        gte(candidatePool.periodEnd, q.from),
        lt(candidatePool.periodEnd, q.to),
      ),
    )
    .orderBy(candidatePool.periodEnd, candidatePool.eventId);
}
