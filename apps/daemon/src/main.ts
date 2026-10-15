#!/usr/bin/env bun
/**
 * Điểm vào daemon. Một image, nhiều vai trò chọn bằng `SERVICE_ROLE`:
 *   scheduler  đồng bộ lịch cron (chỉ chạy MỘT bản)
 *   worker     chạy job, nhân bản được
 *   bot        nhận lượt bấm 👍/👎 (chỉ MỘT bản cho mỗi bot token)
 *   all        cả ba, dùng khi dev và trên Railway ở MVP-0
 */
import { createLogger } from "@radard/core";
import { runMigrations } from "@radard/db";
import { createBoss, ensureQueues } from "./boss.ts";
import { env } from "./env.ts";
import { seedLibrary } from "./jobs/topics.ts";
import { startBot } from "./roles/bot.ts";
import { startScheduler } from "./roles/scheduler.ts";
import { startWorker } from "./roles/worker.ts";
import {
  createChatChannel,
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

  const boss = createBoss(env.databaseUrl, { schedule: runsScheduler });
  boss.on("error", (err) => log.error("pg-boss lỗi", { err: String(err) }));
  await boss.start();
  await ensureQueues(boss);

  const stops: Array<() => void | Promise<void>> = [];
  if (runsScheduler) {
    // Thư viện chủ đề sống trong code: mỗi lần deploy nạp lại, khỏi chạy tay `topics seed`. Chạy lại
    // nhiều lần không đổi gì. Chỉ vai trò scheduler (một bản duy nhất) làm, để không hai bản cùng ghi.
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
      const bot = { db: deps.db, embedder: createEmbedder(deps.db), llm: createLlm(deps.db) };
      stops.push(await startBot(bot, chat));
    } else log.warn("vai trò bot tắt: chưa đặt TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID");
  }
  log.info("đang chạy", { role: env.role });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("dừng", { signal });
    for (const stop of stops) await stop();
    // Chờ job đang chạy làm xong rồi mới đóng; Railway cho khoảng 30 giây sau SIGTERM.
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
