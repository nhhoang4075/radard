/**
 * Scheduler role: syncs cron schedules from the `sources` table to pg-boss.
 *
 * Sources are data in the DB, not code, so changing a schedule or turning off a source takes only
 * one line edit; the next sync applies it without restarting the daemon.
 */
import { createLogger } from "@radard/core";
import { type Database, sources } from "@radard/db";
import type { PgBoss } from "pg-boss";
import {
  BASELINES_CRON,
  DIGEST_CRON,
  type FetchJob,
  PAGES_CRON,
  PROCESS_CRON,
  QUEUE,
  REPO_STATS_CRON,
  VN_TZ,
} from "../boss.ts";

const log = createLogger("scheduler");
const RESYNC_MS = 5 * 60_000;

/** The part of pg-boss that the scheduler uses. Narrowed so tests can pass a fake. */
export type ScheduleApi = Pick<PgBoss, "schedule" | "getSchedules" | "unschedule">;

export interface SyncResult {
  scheduled: number;
  /** Sources whose `cadence` pg-boss does not accept; their old schedules (if any) are kept as they are. */
  failed: Array<{ sourceId: number; cadence: string; error: string }>;
}

export async function syncSchedules(boss: ScheduleApi, db: Database): Promise<SyncResult> {
  const rows = await db.select().from(sources);
  const wanted = new Set<string>();
  const result: SyncResult = { scheduled: 0, failed: [] };

  for (const s of rows) {
    if (!s.enabled) continue;
    const key = String(s.id);
    // Mark "keep" BEFORE registering: if the new cadence is wrong, the old schedule keeps running,
    // instead of being deleted by the unschedule loop below and the source going silent unnoticed.
    wanted.add(key);
    const data: FetchJob = { sourceId: s.id };
    try {
      // `singletonKey` per source, so the queue's `stately` policy blocks overlapping jobs.
      await boss.schedule(QUEUE.fetch, s.cadence, data, { key, singletonKey: key, tz: "UTC" });
      result.scheduled++;
    } catch (err) {
      // One bad source must not break the schedules of the sources after it in the loop.
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ sourceId: s.id, cadence: s.cadence, error });
      log.error("cadence không hợp lệ, giữ lịch cũ", { sourceId: s.id, cadence: s.cadence, error });
    }
  }

  for (const sched of await boss.getSchedules(QUEUE.fetch)) {
    if (sched.key && !wanted.has(sched.key)) {
      await boss.unschedule(QUEUE.fetch, sched.key);
      log.info("gỡ lịch", { sourceId: sched.key });
    }
  }
  log.info("đồng bộ lịch", { scheduled: result.scheduled, failed: result.failed.length });
  return result;
}

export async function startScheduler(boss: PgBoss, db: Database): Promise<() => void> {
  await boss.schedule(
    QUEUE.process,
    PROCESS_CRON,
    {},
    {
      key: "process",
      singletonKey: "process",
      tz: "UTC",
    },
  );
  await boss.schedule(
    QUEUE.baselines,
    BASELINES_CRON,
    {},
    { key: "baselines", singletonKey: "baselines", tz: VN_TZ },
  );
  await boss.schedule(
    QUEUE.pages,
    PAGES_CRON,
    {},
    { key: "pages", singletonKey: "pages", tz: "UTC" },
  );
  await boss.schedule(
    QUEUE.repoStats,
    REPO_STATS_CRON,
    {},
    { key: "repo_stats", singletonKey: "repo_stats", tz: VN_TZ },
  );
  await boss.schedule(
    QUEUE.digest,
    DIGEST_CRON,
    {},
    { key: "digest", singletonKey: "digest", tz: VN_TZ },
  );
  await syncSchedules(boss, db);
  const timer = setInterval(() => {
    syncSchedules(boss, db).catch((err) => log.error("đồng bộ lịch lỗi", { err: String(err) }));
  }, RESYNC_MS);
  return () => clearInterval(timer);
}
