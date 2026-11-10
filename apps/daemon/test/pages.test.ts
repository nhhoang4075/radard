/**
 * Job `pages` và cách job process dùng trang được link tới, trên `radard_test` với bộ tải trang
 * giả: mỗi URL tải một lần, Ask HN không đợi, process đợi trang rồi embed tiêu đề cùng nội dung.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEmbedding } from "@radard/adapters/ai-fake";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import {
  canonicalizeUrl,
  type PageFetcher,
  type PageFetchResult,
  rawKey,
  sha256,
} from "@radard/core";
import {
  createDatabase,
  docText,
  documents,
  EMBED_DIMENSIONS,
  linkedPages,
  runMigrations,
  sources,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import { fetchPages } from "../src/jobs/pages.ts";
import { runProcess } from "../src/jobs/process.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const root = await mkdtemp(join(tmpdir(), "radard-pages-"));
const store = fsObjectStore(root);
const SINCE = new Date("2026-10-01T00:00:00Z");
let sourceId = 0;
let seq = 0;

/** Bộ tải giả: URL nào có trong `pages` thì trả HTML đó, không thì 403. */
function fakeFetcher(pages: Record<string, string>): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async fetch(url): Promise<PageFetchResult> {
      asked.push(url);
      const html = pages[url];
      if (html === undefined) return { status: "failed", httpStatus: 403, error: "HTTP 403" };
      return { status: "ok", httpStatus: 200, contentType: "text/html", finalUrl: url, html };
    },
  };
}

/** Rút chữ giả: lấy nội dung thẻ <p>. */
const extractPage = (html: string) => /<p>(.*)<\/p>/s.exec(html)?.[1] ?? null;

async function addStory(title: string, url: string, fetchedAt = new Date("2026-10-12T10:00:00Z")) {
  const id = String(++seq);
  const body = JSON.stringify({ objectID: id, title, url, created_at_i: 1_791_800_000 });
  const bytes = new TextEncoder().encode(body);
  const sha = sha256(bytes);
  await store.put(rawKey(sha), bytes, "application/json");
  const [d] = await db
    .insert(documents)
    .values({
      sourceId,
      externalId: id,
      url,
      urlCanonical: canonicalizeUrl(url),
      title,
      publishedAt: new Date("2026-10-12T09:00:00Z"),
      fetchedAt,
      contentSha256: sha,
      rawKey: rawKey(sha),
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  return d?.id ?? 0;
}

const processDeps = () => ({
  db,
  store,
  embedder: fakeEmbedding({ dimensions: EMBED_DIMENSIONS }),
  thresholds: { join: 0.9, windowDays: 7 },
  extractPage,
});

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, linked_pages restart identity cascade`,
  );
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN giả", cadence: "*/15 * * * *" })
    .returning({ id: sources.id });
  sourceId = s?.id ?? 0;
});

afterAll(async () => {
  await db.$bun.close();
  await rm(root, { recursive: true, force: true });
});

describe("fetchPages", () => {
  test("mỗi URL tải một lần; Ask HN ghi skipped; lỗi cũng ghi lại và không tải lại", async () => {
    await addStory("Janas", "https://github.com/x/janas");
    await addStory("Janas (repost)", "https://github.com/x/janas?utm_source=hn");
    await addStory("Ask HN: anyone?", "https://news.ycombinator.com/item?id=3");
    await addStory("Paywalled", "https://wsj.com/a");
    const fetcher = fakeFetcher({ "https://github.com/x/janas": "<p>README of Janas</p>" });

    const out = await fetchPages({ db, store, fetcher }, { since: SINCE });
    expect(out).toEqual({ considered: 3, ok: 1, blocked: 0, skipped: 1, failed: 1, deferred: 0 });
    expect(fetcher.asked.sort()).toEqual(["https://github.com/x/janas", "https://wsj.com/a"]);
    const rows = await db.select().from(linkedPages).orderBy(asc(linkedPages.urlCanonical));
    expect(rows.map((r) => [r.status, r.httpStatus])).toEqual([
      ["ok", 200],
      ["skipped", null],
      ["failed", 403],
    ]);
    const raw = await store.get(rows[0]?.rawKey ?? "");
    expect(new TextDecoder().decode(raw ?? new Uint8Array())).toBe("<p>README of Janas</p>");

    expect((await fetchPages({ db, store, fetcher }, { since: SINCE })).considered).toBe(0);
  });
});

describe("fetchPages: deferred", () => {
  test("robots.txt chưa đọc được thì không ghi dòng, lần sau tải khi đã hồi lại", async () => {
    await addStory("Janas", "https://github.com/x/janas");
    let robotsUp = false;
    const asked: string[] = [];
    const fetcher: PageFetcher = {
      async fetch(url): Promise<PageFetchResult> {
        asked.push(url);
        if (!robotsUp) return { status: "deferred", error: "robots.txt không đọc được" };
        return {
          status: "ok",
          httpStatus: 200,
          contentType: "text/html",
          finalUrl: url,
          html: "<p>README</p>",
        };
      },
    };

    const first = await fetchPages({ db, store, fetcher }, { since: SINCE });
    expect(first).toEqual({ considered: 1, ok: 0, blocked: 0, skipped: 0, failed: 0, deferred: 1 });
    expect(await db.select().from(linkedPages)).toHaveLength(0);
    expect(asked).toHaveLength(1); // mỗi lượt chạy chỉ thử một lần

    robotsUp = true;
    const second = await fetchPages({ db, store, fetcher }, { since: SINCE });
    expect(second).toEqual({
      considered: 1,
      ok: 1,
      blocked: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
    });
    const rows = await db.select().from(linkedPages);
    expect(rows.map((r) => r.status)).toEqual(["ok"]);
  });
});

describe("runProcess với trang được link tới", () => {
  test("đợi job pages; có trang thì embed tiêu đề cùng chữ của trang", async () => {
    const recent = new Date(Date.now() - 60_000);
    const janas = await addStory("Janas", "https://github.com/x/janas", recent);
    const ask = await addStory("Ask HN: anyone?", "https://news.ycombinator.com/item?id=2", recent);

    // Chưa có dòng linked_pages, tài liệu còn mới: đợi, không embed.
    expect((await runProcess(processDeps())).embedded).toBe(0);

    await fetchPages(
      {
        db,
        store,
        fetcher: fakeFetcher({
          "https://github.com/x/janas": "<p>Streams MoE weights from SSD.</p>",
        }),
      },
      { since: SINCE },
    );
    expect((await runProcess(processDeps())).embedded).toBe(2);
    const text = async (id: number) =>
      (await db.select({ t: docText.text }).from(docText).where(eq(docText.documentId, id)))[0]?.t;
    expect(await text(janas)).toBe("Janas\n\nStreams MoE weights from SSD.");
    expect(await text(ask)).toBe("Ask HN: anyone?");
    // Hai vector: bản thô để gộp sự kiện, bản có trang để chấm chủ đề.
    const vecs = await db
      .select({ id: docText.documentId, e: docText.embedding, c: docText.contentEmbedding })
      .from(docText)
      .orderBy(asc(docText.documentId));
    expect(vecs.map((v) => v.c !== null)).toEqual([true, false]);
    expect(vecs[0]?.e).not.toEqual(vecs[0]?.c);
  });

  test("đợi quá 30 phút thì embed bằng tiêu đề, không chặn mãi", async () => {
    const id = await addStory(
      "Old story",
      "https://slow.example/a",
      new Date(Date.now() - 3_600_000),
    );
    expect((await runProcess(processDeps())).embedded).toBe(1);
    const [row] = await db
      .select({ t: docText.text })
      .from(docText)
      .where(eq(docText.documentId, id));
    expect(row?.t).toBe("Old story");
  });
});
