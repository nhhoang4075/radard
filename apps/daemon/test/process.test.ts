/**
 * Test tích hợp phần xử lý (job process) trên `radard_test` với embedding GIẢ (băm từ): kiểm
 * chấm điểm theo chủ đề, gộp theo URL, gộp theo vector, mở sự kiện mới và tính chạy lại được. Không kiểm chất lượng: ngưỡng
 * thật phải chỉnh trên model thật.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEmbedding } from "@radard/adapters/ai-fake";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import { canonicalizeUrl, rawKey, sha256 } from "@radard/core";
import {
  createDatabase,
  docText,
  docTopicScores,
  documents,
  EMBED_DIMENSIONS,
  eventDocuments,
  events,
  profile,
  runMigrations,
  sources,
  topics,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import { type ProcessDeps, runProcess } from "../src/jobs/process.ts";
import {
  addCustomTopic,
  listProfileTopics,
  pickTopics,
  setTopicActive,
} from "../src/jobs/topics.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const root = await mkdtemp(join(tmpdir(), "radard-process-"));
const store = fsObjectStore(root);

const deps = (): ProcessDeps => ({
  db,
  store,
  embedder: fakeEmbedding({ dimensions: EMBED_DIMENSIONS }),
  thresholds: { join: 0.5, windowDays: 7 },
});

let sourceId = 0;
let seq = 0;

/** Thêm một story HN giả như job fetch sẽ ghi: bản thô JSON + dòng documents. */
async function addStory(title: string, url: string, at = "2026-09-27T10:00:00Z") {
  const id = String(++seq);
  const body = JSON.stringify({ objectID: id, title, url, created_at_i: Date.parse(at) / 1000 });
  const bytes = new TextEncoder().encode(body);
  const sha = sha256(bytes);
  await store.put(rawKey(sha), bytes, "application/json");
  await db.insert(documents).values({
    sourceId,
    externalId: id,
    url,
    urlCanonical: canonicalizeUrl(url),
    title,
    publishedAt: new Date(at),
    contentSha256: sha,
    rawKey: rawKey(sha),
    contentType: "application/json",
  });
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate sources, events, profile, topics restart identity cascade`);
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN giả", cadence: "*/15 * * * *" })
    .returning({ id: sources.id });
  sourceId = s?.id ?? 0;
  await db.insert(profile).values({ description: "LLM agents and language model tooling" });
});

afterAll(async () => {
  await db.$bun.close();
  await rm(root, { recursive: true, force: true });
});

describe("runProcess", () => {
  test("gộp theo URL, gộp theo vector, mở sự kiện mới; bài lạc đề vẫn thành sự kiện", async () => {
    await addStory("New LLM agents framework for language model tooling", "https://a.com/x");
    await addStory("LLM agents framework released for language model tooling", "https://b.com/y");
    await addStory("Discussion: LLM agents", "https://a.com/x?utm_source=hn");
    await addStory("Gardening tips for growing tomatoes", "https://c.com/z");

    const out = await runProcess(deps());

    expect(out.embedded).toBe(4);
    const links = await db
      .select({
        doc: documents.title,
        event: eventDocuments.eventId,
        reason: eventDocuments.reason,
      })
      .from(eventDocuments)
      .innerJoin(documents, eq(documents.id, eventDocuments.documentId))
      .orderBy(asc(documents.id));
    expect(links.map((l) => l.reason)).toEqual(["seed", "vector", "url", "seed"]);
    // Ba bài agents cùng một sự kiện; bài làm vườn là sự kiện riêng (D4: gộp mọi tài liệu, lọc
    // theo hồ sơ chỉ ở digest).
    expect(new Set(links.map((l) => l.event)).size).toBe(2);
    const [ev] = await db.select().from(events).orderBy(asc(events.id));
    expect(ev?.nDocs).toBe(3);
    expect(ev?.title).toBe("New LLM agents framework for language model tooling");
  });

  test("gộp vì cùng URL không làm lệch trọng số tâm cụm", async () => {
    // seed → cùng URL → vector: tâm phải là trung bình của ĐÚNG 2 vector (A và C), không phải
    // (2A + C) / 3 như khi lấy nDocs làm trọng số.
    await addStory(
      "LLM agents framework for language model tooling",
      "https://a.com/x",
      "2026-09-27T10:00:00Z",
    );
    await addStory(
      "Discussion: LLM agents",
      "https://a.com/x?utm_source=hn",
      "2026-09-27T11:00:00Z",
    );
    await addStory(
      "New LLM agents framework for language model tools",
      "https://b.com/y",
      "2026-09-27T12:00:00Z",
    );

    const out = await runProcess(deps());
    expect([out.created, out.joinedByUrl, out.joinedByVector]).toEqual([1, 1, 1]);

    const [ev] = await db.select().from(events);
    expect(ev?.nDocs).toBe(3);
    expect(ev?.nVectors).toBe(2);

    const [a, , c] = await db.select().from(docText).orderBy(asc(docText.documentId));
    const expected = (a?.embedding ?? []).map((x, i) => (x + (c?.embedding[i] ?? 0)) / 2);
    const maxDiff = Math.max(
      ...(ev?.centroid ?? []).map((x, i) => Math.abs(x - (expected[i] ?? 0))),
    );
    // halfvec lưu 16-bit: sai số làm tròn cỡ 1e-3; lệch trọng số sẽ lớn hơn nhiều.
    expect(maxDiff).toBeLessThan(2e-3);
  });

  test("chạy lại không làm gì thêm", async () => {
    await addStory("LLM agents benchmark", "https://a.com/1");
    await runProcess(deps());
    const again = await runProcess(deps());
    expect(again).toEqual({
      embedded: 0,
      topicsEmbedded: 0,
      scored: 0,
      joinedByUrl: 0,
      joinedByVector: 0,
      created: 0,
    });
    expect((await db.select().from(docText)).length).toBe(1);
  });

  test("ngoài cửa sổ thời gian thì mở sự kiện mới dù nội dung giống", async () => {
    await addStory(
      "LLM agents framework for language model tooling",
      "https://a.com/1",
      "2026-09-01T00:00:00Z",
    );
    await addStory(
      "LLM agents framework for language model tooling",
      "https://b.com/2",
      "2026-09-27T00:00:00Z",
    );
    const out = await runProcess(deps());
    expect(out.created).toBe(2);
    expect(out.joinedByVector).toBe(0);
  });

  test("bài cũ đến muộn không gộp vào sự kiện của nhiều tuần sau", async () => {
    // Như lúc chạy thật: bài mới được xử lý ở lượt trước, bài cũ hơn 26 ngày mới lấy về sau.
    await addStory(
      "LLM agents framework for language model tooling",
      "https://b.com/2",
      "2026-09-27T00:00:00Z",
    );
    await runProcess(deps());
    await addStory(
      "LLM agents framework for language model tooling",
      "https://a.com/1",
      "2026-09-01T00:00:00Z",
    );
    const out = await runProcess(deps());
    expect(out.created).toBe(1);
    expect(out.joinedByVector).toBe(0);
  });

  test("bài cũ đến muộn trong cửa sổ thì gộp và kéo lùi first_seen_at", async () => {
    await addStory(
      "LLM agents framework for language model tooling",
      "https://b.com/2",
      "2026-09-27T00:00:00Z",
    );
    await runProcess(deps());
    await addStory(
      "LLM agents framework for language model tooling",
      "https://a.com/1",
      "2026-09-25T00:00:00Z",
    );
    const out = await runProcess(deps());
    expect(out.joinedByVector).toBe(1);
    const [ev] = await db.select().from(events);
    expect(ev?.firstSeenAt.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(ev?.lastSeenAt.toISOString()).toBe("2026-09-27T00:00:00.000Z");
  });

  test("nguồn tắt gộp theo vector thì mỗi tài liệu một sự kiện", async () => {
    await db.update(sources).set({ config: { vectorJoin: false } });
    await addStory("LLM agents framework for language model tooling v1.0", "https://gh.com/r/1");
    await addStory("LLM agents framework for language model tooling v1.1", "https://gh.com/r/2");
    const out = await runProcess(deps());
    expect(out.created).toBe(2);
    expect(out.joinedByVector).toBe(0);
  });

  test("chấm điểm mọi cặp (tài liệu, chủ đề đang bật); thêm chủ đề thì chỉ chấm cột mới", async () => {
    await addStory("LLM agents framework for language model tooling", "https://a.com/1");
    await addStory("Gardening tips for growing tomatoes", "https://c.com/z");
    await db.insert(topics).values({
      key: "agents",
      groupVi: "AI",
      labelVi: "Agent",
      descriptionEn: "LLM agents framework",
    });
    await pickTopics(db, ["agents"]);
    await addCustomTopic(db, {
      label: "Làm vườn",
      descriptionUser: "trồng cà chua",
      descriptionEn: "gardening tomatoes",
    });
    const [, garden] = await listProfileTopics(db);
    await setTopicActive(db, garden?.id ?? 0, false);

    const out = await runProcess(deps());
    expect(out.topicsEmbedded).toBe(1);
    expect(out.scored).toBe(2);
    const agentsScores = await db
      .select({ doc: docTopicScores.documentId, score: docTopicScores.score })
      .from(docTopicScores)
      .orderBy(asc(docTopicScores.documentId));
    expect(agentsScores[0]?.score ?? 0).toBeGreaterThan(agentsScores[1]?.score ?? 1);

    await setTopicActive(db, garden?.id ?? 0, true);
    const again = await runProcess(deps());
    expect([again.topicsEmbedded, again.scored]).toEqual([1, 2]);
    expect(await runProcess(deps())).toMatchObject({ topicsEmbedded: 0, scored: 0 });
  });

  test("sửa chủ đề không đổi bảng sự kiện", async () => {
    await addStory("LLM agents framework for language model tooling", "https://a.com/1");
    await addStory("Gardening tips for growing tomatoes", "https://c.com/z");
    await runProcess(deps());
    const before = await db.select().from(eventDocuments).orderBy(asc(eventDocuments.documentId));
    await addCustomTopic(db, {
      label: "Làm vườn",
      descriptionUser: "trồng cà chua",
      descriptionEn: "gardening tomatoes",
    });
    const out = await runProcess(deps());
    expect([out.created, out.joinedByUrl, out.joinedByVector]).toEqual([0, 0, 0]);
    expect(await db.select().from(eventDocuments).orderBy(asc(eventDocuments.documentId))).toEqual(
      before,
    );
  });

  test("trần maxCluster: phần còn lại để lượt sau", async () => {
    const titles = ["Rust compiler", "Tomato garden", "Jazz piano", "Mountain bikes", "Sourdough"];
    for (const [i, t] of titles.entries()) await addStory(t, `https://x.com/${i}`);
    const first = await runProcess({ ...deps(), maxCluster: 2 });
    expect(first.created).toBe(2);
    const second = await runProcess({ ...deps(), maxCluster: 10 });
    expect(second.created).toBe(3);
  });
});
