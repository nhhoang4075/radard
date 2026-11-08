/**
 * Vai trò worker: nhận job `fetch` (thu thập) và `process` (xử lý) từ pg-boss.
 */
import { createLogger } from "@radard/core";
import type { PgBoss } from "pg-boss";
import { type FetchJob, QUEUE } from "../boss.ts";
import { env } from "../env.ts";
import { runBaselines } from "../jobs/baselines.ts";
import { runDigest, type SendDeps } from "../jobs/digest.ts";
import { type FetchDeps, rateLimitDelaySeconds, runFetch } from "../jobs/fetch.ts";
import { fetchPages, type PagesDeps } from "../jobs/pages.ts";
import { type ProcessDeps, runProcess } from "../jobs/process.ts";
import { runRepoStats } from "../jobs/repo-stats.ts";

const log = createLogger("worker");

export async function startWorker(
  boss: PgBoss,
  deps: FetchDeps,
  opts: {
    concurrency: number;
    process: ProcessDeps | null;
    digest: SendDeps | null;
    pages: PagesDeps;
  },
): Promise<void> {
  await boss.work<FetchJob>(QUEUE.fetch, { localConcurrency: opts.concurrency }, async (jobs) => {
    for (const job of jobs) {
      let outcome: Awaited<ReturnType<typeof runFetch>>;
      try {
        outcome = await runFetch(job.data.sourceId, deps);
      } catch (err) {
        const attempt = job.data.rateLimited ?? 0;
        const wait = rateLimitDelaySeconds(err, attempt);
        if (wait === null) throw err;
        await boss.send(
          QUEUE.fetch,
          { sourceId: job.data.sourceId, rateLimited: attempt + 1 } satisfies FetchJob,
          { startAfter: wait, singletonKey: String(job.data.sourceId) },
        );
        log.warn("nguồn giới hạn tốc độ (429), hẹn lại", {
          sourceId: job.data.sourceId,
          sauGiay: wait,
          lanHen: attempt + 1,
        });
        continue;
      }
      if (outcome.behind) {
        log.warn("fetch chưa bắt kịp, lượt sau đọc tiếp", {
          sourceId: job.data.sourceId,
          ...outcome,
        });
      } else {
        log.info("fetch xong", { sourceId: job.data.sourceId, ...outcome });
      }
    }
  });
  log.info("đang nhận job", { queue: QUEUE.fetch, concurrency: opts.concurrency });

  await boss.work(QUEUE.baselines, { localConcurrency: 1 }, async () => {
    await runBaselines(deps.db);
  });
  log.info("đang nhận job", { queue: QUEUE.baselines });

  await boss.work(QUEUE.repoStats, { localConcurrency: 1 }, async () => {
    await runRepoStats({ db: deps.db, http: deps.http });
  });
  log.info("đang nhận job", { queue: QUEUE.repoStats, token: Boolean(process.env.GITHUB_TOKEN) });

  const pagesDeps = opts.pages;
  await boss.work(QUEUE.pages, { localConcurrency: 1 }, async () => {
    // Hai ngày: bài lấy về muộn (con trỏ lùi, daemon tắt một lúc) vẫn được tải trang.
    await fetchPages(pagesDeps, { since: new Date(Date.now() - 2 * 86_400_000), limit: 300 });
  });
  log.info("đang nhận job", { queue: QUEUE.pages });

  const digestDeps = opts.digest;
  if (digestDeps) {
    await boss.work(QUEUE.digest, { localConcurrency: 1 }, async () => {
      await runDigest(digestDeps);
    });
    log.info("đang nhận job", { queue: QUEUE.digest, summaries: Boolean(digestDeps.llm) });
  } else log.warn("job digest tắt: chưa đặt TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID");

  const processDeps = opts.process;
  if (!processDeps) {
    log.warn("job process tắt: chưa cấu hình embedder (AI_GATEWAY_API_KEY hoặc EMBEDDER=fake)");
    return;
  }
  await boss.work(QUEUE.process, { localConcurrency: 1 }, async () => {
    // Daemon giới hạn số lô mỗi lượt; CLI `process` thì chạy tới hết.
    await runProcess({
      ...processDeps,
      maxBatches: env.processMaxBatches,
      maxCluster: env.processMaxCluster,
    });
  });
  log.info("đang nhận job", { queue: QUEUE.process, embedder: processDeps.embedder.model });
}
