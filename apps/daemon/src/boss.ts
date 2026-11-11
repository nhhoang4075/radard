/**
 * Job queue on Postgres itself (pg-boss). Queues are declared in one place so the scheduler and
 * worker always see the same configuration.
 */
import { PgBoss } from "pg-boss";

export const QUEUE = {
  fetch: "fetch",
  fetchDead: "fetch_dead",
  process: "process",
  baselines: "baselines",
  digest: "digest",
  pages: "pages",
  repoStats: "repo_stats",
} as const;

/** The process job runs periodically and finds pending work by itself, so one fixed schedule is enough. */
export const PROCESS_CRON = "*/5 * * * *";
/** Fetches the linked pages, on the same rhythm as process (process waits for pages up to 30 minutes). */
export const PAGES_CRON = "*/5 * * * *";

/**
 * Snapshot the GitHub repo star counts at 06:20 Vietnam time (23:20 UTC): after the two repo sources (06:00 Search,
 * 06:10 Trending), so new repos get a first measurement today, before the 07:00 digest.
 */
export const REPO_STATS_CRON = "20 6 * * *";

/** Baselines are recomputed daily at 06:30 Vietnam time, before the 07:00 digest. */
export const BASELINES_CRON = "30 6 * * *";
/** Vietnam time for the hourly schedules (baselines, digest). */
export const VN_TZ = "Asia/Ho_Chi_Minh";

/** Digest at 07:00 Vietnam time (matches `DIGEST_HOUR_VN` in jobs/digest.ts). */
export const DIGEST_CRON = "0 7 * * *";

export interface FetchJob {
  sourceId: number;
  /** Number of times the job was rescheduled because of rate limiting (HTTP 429); empty = regular scheduled run. */
  rateLimited?: number;
}

export function createBoss(databaseUrl: string, opts: { schedule: boolean }): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, schedule: opts.schedule, max: 4 });
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUE.fetchDead, { retentionSeconds: 30 * 24 * 3600 });
  await boss.createQueue(QUEUE.fetch, {
    // `stately`: each source (singletonKey) has at most one pending job and one running job.
    // A slow source does not stack more jobs when the next cron run arrives.
    policy: "stately",
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
    deadLetter: QUEUE.fetchDead,
  });
  await boss.createQueue(QUEUE.process, {
    // One process run at a time: two parallel runs would merge the same document twice.
    policy: "stately",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await boss.createQueue(QUEUE.pages, {
    policy: "stately",
    retryLimit: 1,
    retryDelay: 60,
    expireInSeconds: 1200,
  });
  await boss.createQueue(QUEUE.digest, {
    // One digest run at a time: two parallel runs would send the same position.
    // A retry sends only the missing part (saved plan), not duplicates.
    policy: "stately",
    retryLimit: 4,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 900,
  });
  await boss.createQueue(QUEUE.repoStats, {
    // Safe retry: if the repo was snapshotted in the last 12 hours, the next run skips it and does not write a duplicate.
    policy: "stately",
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    expireInSeconds: 900,
  });
  await boss.createQueue(QUEUE.baselines, {
    policy: "stately",
    retryLimit: 2,
    retryDelay: 120,
    expireInSeconds: 900,
  });
}
