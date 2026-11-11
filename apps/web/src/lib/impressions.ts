/**
 * Logic thuần của ghi lượt hiện (hợp đồng mục 4: ngưỡng 0,5, hẹn 1 giây, huỷ khi rời màn hình hoặc tab ẩn,
 * chống trùng theo (snapshot, position), gom lô). Không đụng DOM nên test được; hook ở `use-impressions.ts` nối vào DOM.
 */
import type { ImpressionInput } from "../features/feed/types.ts";

/** Hằng số một nơi, chỉnh được. */
export const IMPRESSION = {
  /** Tỉ lệ thẻ nằm trong khung nhìn để tính là "hiện". */
  threshold: 0.5,
  /** Phải hiện liên tục bấy lâu (ms) mới ghi. */
  dwellMs: 1000,
  /** Gửi khi đủ bấy nhiêu mục hoặc sau bấy lâu (ms) kể từ mục đầu của lô. */
  batchSize: 10,
  flushMs: 3000,
} as const;

type Timer = unknown;
export type Scheduler = { set(fn: () => void, ms: number): Timer; clear(t: Timer): void };
const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** Hẹn giờ theo từng khoá: `enter` bắt đầu đếm, `leave` huỷ; đủ `ms` thì gọi `onDwell` đúng một lần. */
export function createDwell(
  onDwell: (key: string) => void,
  ms: number = IMPRESSION.dwellMs,
  s: Scheduler = realScheduler,
) {
  const timers = new Map<string, Timer>();
  return {
    enter(key: string) {
      if (timers.has(key)) return;
      timers.set(
        key,
        s.set(() => {
          timers.delete(key);
          onDwell(key);
        }, ms),
      );
    },
    leave(key: string) {
      const t = timers.get(key);
      if (t === undefined) return;
      s.clear(t);
      timers.delete(key);
    },
    /** Huỷ tất cả (tab ẩn, rời trang). */
    clear() {
      for (const t of timers.values()) s.clear(t);
      timers.clear();
    },
  };
}

/** Hàng đợi: chống trùng (snapshot, position) ở phía client, gom lô. */
export function createImpressionQueue(
  send: (batch: ImpressionInput[]) => void,
  opts: { batchSize?: number; flushMs?: number; scheduler?: Scheduler } = {},
) {
  const batchSize = opts.batchSize ?? IMPRESSION.batchSize;
  const flushMs = opts.flushMs ?? IMPRESSION.flushMs;
  const s = opts.scheduler ?? realScheduler;
  const seen = new Set<string>();
  let pending: ImpressionInput[] = [];
  let timer: Timer | undefined;

  const flush = () => {
    if (timer !== undefined) {
      s.clear(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    send(batch);
  };

  return {
    add(snapshotId: number, position: number, seenAt: string) {
      const key = `${snapshotId}:${position}`;
      if (seen.has(key)) return false;
      seen.add(key);
      pending.push({ snapshotId, position, seenAt });
      if (pending.length >= batchSize) flush();
      else if (timer === undefined) timer = s.set(flush, flushMs);
      return true;
    },
    flush,
    get size() {
      return pending.length;
    },
  };
}
