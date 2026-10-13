/**
 * Vai trò scheduler: đồng bộ lịch cron từ bảng `sources` sang pg-boss.
 *
 * Nguồn là dữ liệu trong DB chứ không phải code, nên sửa lịch hay tắt một nguồn chỉ cần
 * sửa một dòng; lần đồng bộ kế tiếp sẽ áp dụng mà không phải khởi động lại daemon.
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
  VN_TZ,
} from "../boss.ts";

const log = createLogger("scheduler");
const RESYNC_MS = 5 * 60_000;

/** Phần pg-boss mà scheduler dùng. Hẹp lại để test truyền bản giả được. */
export type ScheduleApi = Pick<PgBoss, "schedule" | "getSchedules" | "unschedule">;

export interface SyncResult {
  scheduled: number;
  /** Nguồn có `cadence` pg-boss không nhận; lịch cũ của chúng (nếu có) được giữ nguyên. */
  failed: Array<{ sourceId: number; cadence: string; error: string }>;
}

export async function syncSchedules(boss: ScheduleApi, db: Database): Promise<SyncResult> {
  const rows = await db.select().from(sources);
  const wanted = new Set<string>();
  const result: SyncResult = { scheduled: 0, failed: [] };

  for (const s of rows) {
    if (!s.enabled) continue;
    const key = String(s.id);
    // Đánh dấu "cần giữ" TRƯỚC khi đăng ký: cadence mới sai thì lịch cũ vẫn chạy tiếp,
    // thay vì bị vòng gỡ lịch bên dưới xoá mất và nguồn im lặng không ai biết.
    wanted.add(key);
    const data: FetchJob = { sourceId: s.id };
    try {
      // `singletonKey` theo nguồn để chính sách `stately` của queue chặn job chồng nhau.
      await boss.schedule(QUEUE.fetch, s.cadence, data, { key, singletonKey: key, tz: "UTC" });
      result.scheduled++;
    } catch (err) {
      // Một nguồn sai không được làm hỏng lịch của các nguồn đứng sau nó trong vòng lặp.
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
