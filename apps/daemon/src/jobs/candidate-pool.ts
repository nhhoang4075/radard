/**
 * Bể ứng viên: ghi lại mọi sự kiện đã qua cổng của một lần xếp hạng, kèm thành phần điểm và việc
 * có được chọn hay không (bảng `candidate_pool`). Chỉ GHI THÊM, không đổi cách chọn tin.
 *
 * Dữ liệu này để tính sàn theo phân vị sau này; kế hoạch gửi chỉ giữ điểm của tin đã chọn.
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
    u: null,
    score: x.S,
    penalty: state.selected ? state.penalty : null,
    selected: state.selected,
    rejectReason: state.selected ? null : state.reason,
  };
}

/**
 * Các dòng của bể: tin được chọn và mọi tin qua cổng nhưng bị loại sau đó (sàn, tin đã gửi không
 * có gì mới, hạn mức nguồn, không đủ chỗ). Tin bị cổng loại không vào bể.
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
 * Ghi bể của một lần xếp hạng. Chạy lại cùng khoảng thì cập nhật dòng cũ và xoá dòng không còn
 * trong kết quả mới, nên không nhân đôi. Ném lỗi nếu ghi hỏng; luồng gửi tin dùng
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
    // Postgres giới hạn số tham số mỗi câu lệnh: chia lô.
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
 * Quyết định: ghi bể là việc phụ, KHÔNG được làm hỏng hay chặn việc gửi tin. Lỗi được log rồi
 * nuốt; lần xếp hạng này mất dữ liệu bể (chấp nhận được: sàn theo phân vị tính trên 30 ngày).
 * Việc ghi nằm trong giao dịch riêng, tách khỏi mọi thao tác của luồng gửi.
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

/** Đọc các dòng của bể có `period_end` trong [from, to), theo hồ sơ, cũ đến mới. */
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
