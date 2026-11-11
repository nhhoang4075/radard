/**
 * Tóm tắt dùng chung (summaries.ts, quyết định 11/11/2026): prompt không có câu "với bạn", cache theo
 * (sự kiện, ngôn ngữ, docs_hash), tính lại khi sự kiện có thêm bài, hai hồ sơ dùng chung một dòng, lỗi
 * một lô không làm hỏng cả bản chụp, và `feed_items.summary_id` ổn định.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeLlm } from "@radard/adapters/ai-fake";
import {
  baselines,
  createDatabase,
  docTopicScores,
  documents,
  eventDocuments,
  eventSummaries,
  events,
  feedItems,
  profile,
  profileTopics,
  runMigrations,
  sources,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { ensureFeedSnapshot } from "../src/jobs/feed.ts";
import {
  docsHashOf,
  ensureSharedSummaries,
  SUMMARY_BATCH_SIZE,
  summaryPrompt,
  summarySystem,
} from "../src/jobs/summaries.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const SLOT = new Date("2026-10-06T00:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
let hn = 0;
let topic = 0;
let seq = 0;

async function addDoc(): Promise<number> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
      externalId: String(1000 + id),
      url: `https://www.site${id}.com/post`,
      urlCanonical: `https://site${id}.com/post`,
      title: `Original title ${id}`,
      publishedAt: IN,
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  return d?.id ?? 0;
}

/** Sự kiện thật (cho bản chụp feed): một tài liệu điểm chủ đề cao. */
async function addEvent(): Promise<{ eventId: number; docId: number }> {
  const docId = await addDoc();
  const v = new Array(1024).fill(0);
  v[seq % 1024] = 1;
  const [e] = await db
    .insert(events)
    .values({
      title: `seed ${seq}`,
      firstSeenAt: IN,
      lastSeenAt: IN,
      centroid: v,
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  const eventId = e?.id ?? 0;
  await db
    .insert(eventDocuments)
    .values({ eventId, documentId: docId, similarity: 1, reason: "seed" });
  await db.insert(docTopicScores).values({ documentId: docId, topicId: topic, score: 0.79 });
  return { eventId, docId };
}

/** LLM giả: mỗi `Story n` một tóm tắt mang tên tiêu đề tài liệu đầu tiên; ghi lại mọi lời gọi. */
function summaryLlm(opts: { failWhen?: (prompt: string) => boolean } = {}) {
  const calls: { prompt: string; system?: string }[] = [];
  const llm = fakeLlm({
    reply(prompt, system) {
      calls.push({ prompt, system });
      if (opts.failWhen?.(prompt)) throw new Error("model lỗi");
      const n = (prompt.match(/^Story \d+$/gm) ?? []).length;
      const items = Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        title: `Tiêu đề chung ${i + 1}`,
        summary: `Tóm tắt chung số ${i + 1}, đủ dài để qua kiểm tra.`,
      }));
      return JSON.stringify({ items });
    },
  });
  return { llm, calls };
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, event_summaries restart identity cascade`,
  );
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  hn = s?.id ?? 0;
  await db.insert(profile).values({ promptContext: "I build AI agents.", displayLang: "vi" });
  topic = await addTopic(db, "Agent AI", { embedText: "agents" });
  await db.insert(baselines).values([
    {
      metric: "relevance",
      sourceId: hn,
      topicId: topic,
      median: 0.4,
      p999: 0.8,
      n: 10_000,
      windowDays: 30,
    },
    { metric: "engagement", sourceId: hn, median: 1, p999: 7, n: 10_000, windowDays: 30 },
    { metric: "coverage", median: 0.3, p999: 2, n: 10_000, windowDays: 30 },
  ]);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("prompt tóm tắt chung", () => {
  test("bỏ hẳn câu 'với bạn' và bối cảnh người đọc; giữ các luật còn lại", () => {
    const system = summarySystem("vi");
    expect(system).not.toContain("why it matters to this reader");
    expect(system).not.toContain("About the reader");
    expect(system).not.toContain("this reader");
    expect(system).toContain("Use only the facts in the input.");
    expect(system).toContain("Never comment on the input itself");
    expect(system).toContain("title: at most 12 words.");
    expect(system).toContain(
      "summary: 2-3 sentences: what happened, and the context needed to understand it.",
    );
    expect(system).toContain("Keep product, company, model and library names as they are.");
    expect(system).toContain("Write in Vietnamese");
    expect(summarySystem("en")).toContain("Write in English");
    expect(summaryPrompt([{ n: 1, docs: [] }])).toBe("Story 1\nDocuments:");
  });
});

describe("ensureSharedSummaries", () => {
  const item = async (nDocs = 1) => {
    const ids: number[] = [];
    for (let i = 0; i < nDocs; i++) ids.push(await addDoc());
    return { eventId: 7000 + seq, documentIds: ids, topicId: null };
  };

  test("lần đầu gọi model theo lô; lần hai cache hit không gọi model", async () => {
    const items = [await item(), await item(), await item()];
    const { llm, calls } = summaryLlm();
    const first = await ensureSharedSummaries({ db, llm }, items, "vi");
    expect(first).toMatchObject({ requested: 3, failed: 0 });
    expect(calls).toHaveLength(1); // một lô
    expect(calls[0]?.system).not.toContain("this reader");
    expect(calls[0]?.prompt).not.toContain("why it matters");
    const rows = await db.select().from(eventSummaries);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.model === "fake-llm" && r.lang === "vi")).toBe(true);

    const second = await ensureSharedSummaries({ db, llm }, items, "vi");
    expect(second).toMatchObject({ requested: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect([...second.byEvent.values()].map((s) => s.id).sort()).toEqual(
      [...first.byEvent.values()].map((s) => s.id).sort(),
    );
    // Ngôn ngữ khác là bản khác.
    await ensureSharedSummaries({ db, llm }, items, "en");
    expect(calls).toHaveLength(2);
    expect(await db.select().from(eventSummaries)).toHaveLength(6);
  });

  test("sự kiện có thêm bài: docs_hash đổi nên tính lại; dòng cũ giữ nguyên", async () => {
    const it = await item(2);
    const { llm, calls } = summaryLlm();
    const a = await ensureSharedSummaries({ db, llm }, [it], "vi");
    const old = a.byEvent.get(it.eventId);
    const withMore = { ...it, documentIds: [...it.documentIds, await addDoc()] };
    const b = await ensureSharedSummaries({ db, llm }, [withMore], "vi");
    expect(calls).toHaveLength(2);
    expect(b.byEvent.get(it.eventId)?.id).not.toBe(old?.id);
    expect(await db.select().from(eventSummaries)).toHaveLength(2);
    // Tập tài liệu cũ vẫn ra đúng dòng cũ (không gọi model).
    const again = await ensureSharedSummaries({ db, llm }, [it], "vi");
    expect(again.byEvent.get(it.eventId)?.id).toBe(old?.id);
    expect(calls).toHaveLength(2);
    expect(docsHashOf([3, 1, 2])).toBe(docsHashOf([1, 2, 3]));
    expect(docsHashOf([1, 2])).not.toBe(docsHashOf([1, 2, 3]));
  });

  test("lỗi một lô (thử lại đúng một lần) chỉ làm tin của lô đó thiếu tóm tắt; lô khác vẫn có", async () => {
    const items = [];
    for (let i = 0; i < SUMMARY_BATCH_SIZE + 2; i++) items.push(await item());
    // Lô đầu có "Story 10"; lô sau chỉ có Story 1-2.
    const { llm, calls } = summaryLlm({ failWhen: (p) => p.includes("Story 10") });
    const res = await ensureSharedSummaries({ db, llm }, items, "vi");
    expect(res).toMatchObject({ requested: 12, failed: SUMMARY_BATCH_SIZE });
    expect(res.byEvent.size).toBe(2);
    expect(calls).toHaveLength(3); // lô lỗi 2 lần + lô tốt 1 lần
    // Lần sau chỉ hỏi lại 10 tin còn thiếu.
    const retry = await ensureSharedSummaries({ db, llm: summaryLlm().llm }, items, "vi");
    expect(retry).toMatchObject({ requested: 10, failed: 0 });
  });

  test("không có model: chỉ trả phần đã có cache, không lỗi", async () => {
    const it = await item();
    const res = await ensureSharedSummaries({ db, llm: null }, [it], "vi");
    expect(res).toMatchObject({ requested: 1, failed: 1 });
    expect(res.byEvent.size).toBe(0);
  });
});

describe("bản chụp feed", () => {
  async function secondProfile() {
    await db
      .insert(profile)
      .values({ id: 2, promptContext: "I study robotics.", displayLang: "vi" });
    await db.insert(profileTopics).values({ profileId: 2, topicId: topic });
  }

  test("mọi tin của bản chụp có summary_id; hai hồ sơ cùng sự kiện dùng CHUNG một dòng và một lần gọi model", async () => {
    await secondProfile();
    for (let i = 0; i < 3; i++) await addEvent();
    const { llm, calls } = summaryLlm();
    const one = await ensureFeedSnapshot({ db, profileId: 1, llm }, SLOT);
    const two = await ensureFeedSnapshot({ db, profileId: 2, llm }, SLOT);
    expect(one.items).toHaveLength(3);
    expect(two.items).toHaveLength(3);
    expect(one.items.every((i) => i.summaryId !== null)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await db.select().from(eventSummaries)).toHaveLength(3);
    const byEvent = (items: typeof one.items) =>
      new Map(items.map((i) => [i.eventId, i.summaryId]));
    expect(byEvent(one.items)).toEqual(byEvent(two.items));
  });

  test("summary_id ổn định: sự kiện về sau có thêm bài thì bản chụp đã dựng vẫn trỏ tóm tắt cũ", async () => {
    const { eventId } = await addEvent();
    const { llm, calls } = summaryLlm();
    const built = await ensureFeedSnapshot({ db, profileId: 1, llm }, SLOT);
    const before = built.items[0]?.summaryId;
    expect(before).not.toBeNull();
    const extra = await addDoc();
    await db
      .insert(eventDocuments)
      .values({ eventId, documentId: extra, similarity: 1, reason: "seed" });
    const again = await ensureFeedSnapshot({ db, profileId: 1, llm }, SLOT);
    expect(again.built).toBe(false);
    expect(again.items[0]?.summaryId).toBe(before ?? -1);
    expect(calls).toHaveLength(1);
    const [row] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, again.items[0]?.id ?? 0));
    expect(row?.summaryId).toBe(before ?? -1);
  });

  test("model lỗi: bản chụp vẫn dựng xong, summary_id rỗng (tin hiện tiêu đề gốc)", async () => {
    await addEvent();
    const { llm } = summaryLlm({ failWhen: () => true });
    const res = await ensureFeedSnapshot({ db, profileId: 1, llm }, SLOT);
    expect(res.snapshot.status).toBe("ready");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.summaryId).toBeNull();
    expect(await db.select().from(eventSummaries)).toHaveLength(0);
    // Không llm: cũng dựng được.
    const none = await ensureFeedSnapshot(
      { db, profileId: 1, llm: null },
      new Date("2026-10-07T00:00:00Z"),
    );
    expect(none.snapshot.status).toBe("ready");
  });
});
