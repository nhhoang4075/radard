import { describe, expect, test } from "bun:test";
import { createDwell, createImpressionQueue, type Scheduler } from "../src/lib/impressions.ts";

/** Đồng hồ giả: chạy hẹn giờ theo ý muốn, không chờ thật. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const s: Scheduler = {
    set(fn, ms) {
      jobs.set(++id, { at: now + ms, fn });
      return id;
    },
    clear(t) {
      jobs.delete(t as number);
    },
  };
  return {
    s,
    tick(ms: number) {
      now += ms;
      for (const [k, j] of [...jobs]) {
        if (j.at <= now) {
          jobs.delete(k);
          j.fn();
        }
      }
    },
  };
}

describe("createDwell", () => {
  test("hiện đủ 1 giây mới ghi, đúng một lần", () => {
    const c = fakeClock();
    const got: string[] = [];
    const d = createDwell((k) => got.push(k), 1000, c.s);
    d.enter("3");
    d.enter("3"); // vào lại khi đang đếm: không đếm đôi
    c.tick(999);
    expect(got).toEqual([]);
    c.tick(1);
    expect(got).toEqual(["3"]);
  });

  test("rời màn hình trước 1 giây thì huỷ", () => {
    const c = fakeClock();
    const got: string[] = [];
    const d = createDwell((k) => got.push(k), 1000, c.s);
    d.enter("1");
    c.tick(500);
    d.leave("1");
    c.tick(2000);
    expect(got).toEqual([]);
  });

  test("clear (tab ẩn) huỷ mọi hẹn giờ", () => {
    const c = fakeClock();
    const got: string[] = [];
    const d = createDwell((k) => got.push(k), 1000, c.s);
    d.enter("1");
    d.enter("2");
    d.clear();
    c.tick(5000);
    expect(got).toEqual([]);
  });
});

describe("createImpressionQueue", () => {
  test("chống trùng theo (snapshot, position)", () => {
    const sent: unknown[][] = [];
    const c = fakeClock();
    const q = createImpressionQueue((b) => sent.push(b), { scheduler: c.s });
    expect(q.add(7, 1, "t")).toBe(true);
    expect(q.add(7, 1, "t2")).toBe(false);
    expect(q.add(8, 1, "t")).toBe(true); // snapshot khác thì không trùng
    q.flush();
    expect(sent).toEqual([
      [
        { snapshotId: 7, position: 1, seenAt: "t" },
        { snapshotId: 8, position: 1, seenAt: "t" },
      ],
    ]);
    // đã gửi rồi vẫn nhớ: không gửi lại ở lô sau
    expect(q.add(7, 1, "t3")).toBe(false);
  });

  test("gom lô: đủ batchSize thì gửi, không đủ thì gửi sau flushMs", () => {
    const sent: number[] = [];
    const c = fakeClock();
    const q = createImpressionQueue((b) => sent.push(b.length), {
      batchSize: 3,
      flushMs: 3000,
      scheduler: c.s,
    });
    q.add(1, 1, "t");
    q.add(1, 2, "t");
    expect(sent).toEqual([]);
    q.add(1, 3, "t");
    expect(sent).toEqual([3]);
    q.add(1, 4, "t");
    c.tick(3000);
    expect(sent).toEqual([3, 1]);
  });

  test("flush rỗng không gửi gì", () => {
    const sent: unknown[] = [];
    createImpressionQueue((b) => sent.push(b)).flush();
    expect(sent).toEqual([]);
  });
});
