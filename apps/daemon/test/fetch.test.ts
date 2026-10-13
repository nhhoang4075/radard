/**
 * Test tích hợp job `fetch` trên database `radard_test` thật, với adapter nguồn giả.
 * Kiểm những gì làm nên tính idempotent: chạy lại không trùng, lỗi không làm hỏng con trỏ.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import type { RawItem, SourceAdapter } from "@radard/core";
import {
  createDatabase,
  documents,
  fetchRuns,
  runMigrations,
  sourceState,
  sources,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { type FetchDeps, runFetch } from "../src/jobs/fetch.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const root = await mkdtemp(join(tmpdir(), "radard-fetch-"));

/** Adapter giả: trả các mục cho trước, đếm con trỏ, có thể được bảo ném lỗi. */
function fakeAdapter(items: RawItem[], opts: { fail?: boolean } = {}): SourceAdapter {
  return {
    kind: "fake",
    async fetch({ state }) {
      if (opts.fail) throw new Error("nguồn sập");
      const cursor = ((state as { n?: number } | undefined)?.n ?? 0) + 1;
      return { items, state: { n: cursor }, httpStatus: 200 };
    },
  };
}

const item = (id: string): RawItem => ({
  externalId: id,
  url: `https://example.com/p/${id}?utm_source=hn`,
  title: `Bài ${id}`,
  publishedAt: new Date("2026-09-28T00:00:00Z"),
  body: JSON.stringify({ id }),
  contentType: "application/json",
});

function deps(adapter: SourceAdapter): FetchDeps {
  return {
    db,
    store: fsObjectStore(root),
    http: { get: () => Promise.reject(new Error("không được gọi mạng trong test")) },
    resolveAdapter: () => adapter,
  };
}

let sourceId = 0;

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate sources restart identity cascade`);
  const [row] = await db
    .insert(sources)
    .values({ kind: "fake", name: "Nguồn giả", cadence: "*/15 * * * *" })
    .returning({ id: sources.id });
  sourceId = row?.id ?? 0;
});

afterAll(async () => {
  await db.$bun.close();
  await rm(root, { recursive: true, force: true });
});

describe("runFetch", () => {
  test("chạy hai lần với cùng dữ liệu không sinh bản trùng", async () => {
    const first = await runFetch(sourceId, deps(fakeAdapter([item("1"), item("2")])));
    const second = await runFetch(sourceId, deps(fakeAdapter([item("1"), item("2"), item("3")])));

    expect(first).toMatchObject({ status: "ok", nFetched: 2, nNew: 2 });
    expect(second).toMatchObject({ status: "ok", nFetched: 3, nNew: 1 });
    const docs = await db.select().from(documents).where(eq(documents.sourceId, sourceId));
    expect(docs).toHaveLength(3);
    expect(docs[0]?.urlCanonical).toBe("https://example.com/p/1");
  });

  test("bản thô được lưu và đọc lại đúng nội dung", async () => {
    await runFetch(sourceId, deps(fakeAdapter([item("7")])));
    const [doc] = await db.select().from(documents).where(eq(documents.externalId, "7"));
    const raw = await fsObjectStore(root).get(doc?.rawKey ?? "");
    expect(new TextDecoder().decode(raw ?? new Uint8Array())).toBe(JSON.stringify({ id: "7" }));
  });

  test("con trỏ chỉ tiến khi lượt chạy thành công", async () => {
    await runFetch(sourceId, deps(fakeAdapter([item("1")])));
    await expect(runFetch(sourceId, deps(fakeAdapter([], { fail: true })))).rejects.toThrow(
      "nguồn sập",
    );

    const [state] = await db.select().from(sourceState).where(eq(sourceState.sourceId, sourceId));
    expect(state?.state).toEqual({ n: 1 });
    expect(state?.failCount).toBe(1);

    const runs = await db.select().from(fetchRuns).where(eq(fetchRuns.sourceId, sourceId));
    expect(runs.map((r) => r.status).sort()).toEqual(["error", "ok"]);
    expect(runs.find((r) => r.status === "error")?.error).toBe("nguồn sập");
  });

  test("thành công sau lỗi thì đặt lại fail_count", async () => {
    await expect(runFetch(sourceId, deps(fakeAdapter([], { fail: true })))).rejects.toThrow();
    await runFetch(sourceId, deps(fakeAdapter([item("1")])));
    const [state] = await db.select().from(sourceState).where(eq(sourceState.sourceId, sourceId));
    expect(state?.failCount).toBe(0);
  });

  test("lượt chưa bắt kịp: lưu mục và con trỏ đã lấy đủ, đánh dấu behind kèm lý do", async () => {
    const behindAdapter: SourceAdapter = {
      kind: "fake",
      async fetch() {
        return {
          items: [item("1"), item("2")],
          state: { n: 7 },
          behind: "hết ngân sách 2 mục mỗi lượt",
        };
      },
    };
    const out = await runFetch(sourceId, deps(behindAdapter));
    expect(out).toMatchObject({
      status: "behind",
      nNew: 2,
      behind: "hết ngân sách 2 mục mỗi lượt",
    });
    const [run] = await db.select().from(fetchRuns).where(eq(fetchRuns.id, out.runId));
    expect(run?.status).toBe("behind");
    expect(run?.note).toBe("hết ngân sách 2 mục mỗi lượt");
    const [state] = await db.select().from(sourceState).where(eq(sourceState.sourceId, sourceId));
    expect(state?.state).toEqual({ n: 7 });
  });
});
