#!/usr/bin/env bun
/**
 * Daemon entry point. One image, several roles, selected with `SERVICE_ROLE`:
 *   scheduler  syncs the cron schedule (run ONE instance only)
 *   worker     runs jobs, can be replicated
 *   bot        receives 👍/👎 presses (ONE instance per bot token only)
 *   web        HTTP server: /healthz, /o/:token (tracks link opens), /api (sign-in) and the web UI
 *   all        all four, used in dev and on Railway in MVP-0
 */
import { createLogger } from "@radard/core";
import { runMigrations } from "@radard/db";
import { createBoss, ensureQueues } from "./boss.ts";
import { env } from "./env.ts";
import { seedLibrary } from "./jobs/topics.ts";
import { startBot } from "./roles/bot.ts";
import { startScheduler } from "./roles/scheduler.ts";
import { startWeb } from "./roles/web.ts";
import { startWorker } from "./roles/worker.ts";
import {
  createChatChannel,
  createDecider,
  createDeps,
  createDigestDeps,
  createEmbedder,
  createLlm,
  createPagesDeps,
  createProcessDeps,
} from "./runtime.ts";

const log = createLogger("radard");

async function main(): Promise<void> {
  await runMigrations(env.databaseUrl);
  const deps = createDeps();
  const runsScheduler = env.role === "scheduler" || env.role === "all";
  const runsWorker = env.role === "worker" || env.role === "all";
  const runsBot = env.role === "bot" || env.role === "all";
  const runsWeb = env.role === "web" || env.role === "all";

  const boss = createBoss(env.databaseUrl, { schedule: runsScheduler });
  boss.on("error", (err) => log.error("pg-boss lỗi", { err: String(err) }));
  await boss.start();
  await ensureQueues(boss);

  const stops: Array<() => void | Promise<void>> = [];
  if (runsScheduler) {
    // The topic library lives in code: each deploy reloads it, so `topics seed` need not be run by hand. Running it
    // many times changes nothing. Only the scheduler role (a single instance) does this, so two instances do not write at the same time.
    log.info("thư viện chủ đề", await seedLibrary(deps.db));
    stops.push(await startScheduler(boss, deps.db));
  }
  if (runsWorker) {
    await startWorker(boss, deps, {
      concurrency: env.fetchConcurrency,
      process: createProcessDeps(deps),
      digest: createDigestDeps(deps),
      pages: createPagesDeps(deps),
    });
  }
  if (runsBot) {
    const chat = createChatChannel();
    if (chat) {
      const bot = {
        db: deps.db,
        embedder: createEmbedder(deps.db),
        llm: createLlm(deps.db),
        decider: createDecider(deps.db),
        forMeDailyLimit: env.forMeDailyLimit,
      };
      stops.push(await startBot(bot, chat));
    } else log.warn("vai trò bot tắt: chưa đặt TELEGRAM_BOT_TOKEN");
  }
  if (runsWeb) {
    const stopWeb = startWeb({
      db: deps.db,
      port: env.port,
      secret: env.linkSecret,
      auth: env.auth,
      llm: createLlm(deps.db),
      forMeDailyLimit: env.forMeDailyLimit,
    });
    stops.push(stopWeb);
  }
  log.info("đang chạy", { role: env.role });

  // Measure the process's own RAM to tell whether it sits in the JS heap or outside it (Railway bills by RAM).
  const mb = (n: number) => Math.round(n / 1_048_576);
  const memTimer = setInterval(() => {
    const m = process.memoryUsage();
    log.info("bộ nhớ", {
      rssMb: mb(m.rss),
      heapUsedMb: mb(m.heapUsed),
      heapTotalMb: mb(m.heapTotal),
      externalMb: mb(m.external),
      arrayBuffersMb: mb(m.arrayBuffers),
    });
  }, 5 * 60_000);
  memTimer.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("dừng", { signal });
    for (const stop of stops) await stop();
    // Wait for running jobs to finish before closing; Railway allows about 30 seconds after SIGTERM.
    await boss.stop({ graceful: true, timeout: 25_000 });
    await deps.db.$bun.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("khởi động thất bại", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
