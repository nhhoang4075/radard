/**
 * Pure logic for recording impressions (contract section 4: threshold 0,5, 1-second timer, cancelled when leaving the screen or the tab is hidden,
 * dedup by (snapshot, position), batching). No DOM access, so it is testable; the hook in `use-impressions.ts` connects it to the DOM.
 */
import type { ImpressionInput } from "../features/feed/types.ts";

/** Constants in one place, adjustable. */
export const IMPRESSION = {
  /** Share of the card inside the viewport to count as "shown". */
  threshold: 0.5,
  /** Must stay visible for this long (ms) before it is recorded. */
  dwellMs: 1000,
  /** Send when this many items are queued or after this long (ms) since the first item of the batch. */
  batchSize: 10,
  flushMs: 3000,
} as const;

type Timer = unknown;
export type Scheduler = { set(fn: () => void, ms: number): Timer; clear(t: Timer): void };
const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** Timer per key: `enter` starts counting, `leave` cancels; after `ms` it calls `onDwell` exactly once. */
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
    /** Cancel all (tab hidden, leaving the page). */
    clear() {
      for (const t of timers.values()) s.clear(t);
      timers.clear();
    },
  };
}

/** Queue: client-side dedup by (snapshot, position), batching. */
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
    add(snapshotId: number, position: number) {
      const key = `${snapshotId}:${position}`;
      if (seen.has(key)) return false;
      seen.add(key);
      pending.push({ snapshotId, position });
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
