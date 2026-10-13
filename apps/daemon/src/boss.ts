/**
 * Hàng đợi job trên chính Postgres (pg-boss). Khai báo queue một chỗ để scheduler và
 * worker luôn thấy cùng một cấu hình.
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

/** Job process chạy định kỳ và tự tìm việc còn thiếu, nên một lịch cố định là đủ. */
export const PROCESS_CRON = "*/5 * * * *";
/** Tải trang được link tới, cùng nhịp với process (process đợi trang tối đa 30 phút). */
export const PAGES_CRON = "*/5 * * * *";

/**
 * Chụp số sao repo GitHub lúc 06:20 giờ Việt Nam (23:20 UTC): sau hai nguồn repo (06:00 Search,
 * 06:10 Trending) để repo mới thấy hôm nay có lần đo đầu, trước digest 07:00.
 */
export const REPO_STATS_CRON = "20 6 * * *";

/** Mặt bằng tính lại mỗi ngày lúc 06:30 giờ Việt Nam, trước digest 07:00. */
export const BASELINES_CRON = "30 6 * * *";
/** Giờ Việt Nam cho các lịch theo giờ của bạn (mặt bằng, điểm tin). */
export const VN_TZ = "Asia/Ho_Chi_Minh";

/** Điểm tin lúc 07:00 giờ Việt Nam (khớp `DIGEST_HOUR_VN` trong jobs/digest.ts). */
export const DIGEST_CRON = "0 7 * * *";

export interface FetchJob {
  sourceId: number;
}

export function createBoss(databaseUrl: string, opts: { schedule: boolean }): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, schedule: opts.schedule, max: 4 });
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUE.fetchDead, { retentionSeconds: 30 * 24 * 3600 });
  await boss.createQueue(QUEUE.fetch, {
    // `stately`: mỗi nguồn (singletonKey) tối đa một job đang chờ và một job đang chạy.
    // Nguồn chậm thì lượt cron kế tiếp không chồng thêm job lên.
    policy: "stately",
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
    deadLetter: QUEUE.fetchDead,
  });
  await boss.createQueue(QUEUE.process, {
    // Một lượt process tại một thời điểm: hai lượt chạy song song sẽ cùng gộp một tài liệu.
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
    // Một lượt tại một thời điểm: hai lượt song song sẽ cùng gửi một vị trí.
    // Thử lại thì gửi tiếp phần thiếu (plan đã lưu), không gửi trùng.
    policy: "stately",
    retryLimit: 4,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 900,
  });
  await boss.createQueue(QUEUE.repoStats, {
    // Thử lại an toàn: repo đã chụp trong 12 giờ qua thì lượt sau bỏ qua, không ghi trùng.
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
