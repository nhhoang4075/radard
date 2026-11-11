/**
 * Integration test of the processing job (process) on `radard_test` with FAKE embeddings (word hashing): checks
 * topic scoring, merging by URL, merging by vector, opening new events, and rerunnability. It does not check quality: the thresholds
 * must be tuned on the real model.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDecision, fakeEmbedding, fakeLlm } from "@radard/adapters/ai-fake";
import { fsObjectStore } from "@radard/adapters/object-store-fs";
import {
  canonicalizeUrl,
  type DecisionState,
  type EmbeddingProvider,
  rawKey,
  sha256,
  type UsageEvent,
} from "@radard/core";
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
  topicExamples,
  topics,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import {
  DECISION_JOIN_LOW,
  type ProcessDeps,
  rebuildEvents,
  runProcess,
  SAME_STORY_QUESTION,
} from "../src/jobs/process.ts";
import { resetExampleBackoff } from "../src/jobs/topic-examples.ts";
import {
  addCustomTopic,
  listProfileTopics,
  pickTopics,
  seedLibrary,
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

/** Add a fake HN story as the fetch job would write it: raw JSON + a documents row. */
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
  await db.insert(profile).values({ promptContext: "LLM agents and language model tooling" });
});

afterAll(async () => {
  await db.$bun.close();
  await rm(root, { recursive: true, force: true });
});

describe("tin giả định của chủ đề (HyDE, đề xuất C)", () => {
  const TITLE = "Zebra quantum kernels land in the toolkit";
  const llm = fakeLlm({
    reply: () =>
      JSON.stringify([
        TITLE,
        "Obsidian walrus compiler adds lazy scheduling support",
        "Marmot vector store ships incremental snapshots today",
        "Falcon sandbox isolates untrusted tool calls cheaply",
      ]),
  });
  const agentsExamples = async () => {
    const [t] = await db.select({ id: topics.id }).from(topics).where(eq(topics.key, "agents"));
    return db
      .select()
      .from(topicExamples)
      .where(eq(topicExamples.topicId, t?.id ?? 0));
  };
  const scoreOf = async () => {
    const [t] = await db.select({ id: topics.id }).from(topics).where(eq(topics.key, "agents"));
    const [r] = await db
      .select({ score: docTopicScores.score })
      .from(docTopicScores)
      .where(eq(docTopicScores.topicId, t?.id ?? 0));
    return r?.score ?? Number.NaN;
  };

  test("chấm theo cosine lớn nhất giữa mô tả và tin giả định, nhờ vậy tin cùng kiểu câu lên điểm", async () => {
    await seedLibrary(db);
    await pickTopics(db, 1, ["agents"]);
    await addStory(TITLE, "https://z.com/1");
    await runProcess(deps());
    const without = await scoreOf();
    expect(await db.select().from(topicExamples)).toHaveLength(0);

    await db.delete(docTopicScores);
    await runProcess({ ...deps(), llm });
    expect(await agentsExamples()).toHaveLength(4);
    const withExamples = await scoreOf();
    expect(withExamples).toBeGreaterThan(without);
    expect(withExamples).toBeGreaterThan(0.95);
  });

  test("thêm tin giả định thì xoá điểm cũ để tính lại; có đủ rồi thì không gọi LLM nữa", async () => {
    await seedLibrary(db);
    await pickTopics(db, 1, ["agents"]);
    await addStory(TITLE, "https://z.com/1");
    await runProcess(deps());
    expect(await scoreOf()).toBeLessThan(0.95);
    let empty = 0;
    const failing = fakeLlm({
      reply: () => {
        empty++;
        return "[]";
      },
    });
    // Empty result: error, nothing saved, old scores kept.
    await runProcess({ ...deps(), llm: failing });
    expect(await db.select().from(topicExamples)).toHaveLength(0);
    expect(empty).toBeGreaterThan(0);

    resetExampleBackoff();
    await runProcess({ ...deps(), llm });
    expect(await agentsExamples()).toHaveLength(4);
    const before = empty;
    await runProcess({ ...deps(), llm: failing });
    expect(empty).toBe(before);
  });
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
    // Three "agents" articles in one event; the gardening article is its own event (D4: merge all documents, filter
    // by profile only in the digest).
    expect(new Set(links.map((l) => l.event)).size).toBe(2);
    const [ev] = await db.select().from(events).orderBy(asc(events.id));
    expect(ev?.nDocs).toBe(3);
    expect(ev?.title).toBe("New LLM agents framework for language model tooling");
  });

  test("gộp vì cùng URL không làm lệch trọng số tâm cụm", async () => {
    // seed → same URL → vector: the centroid must be the average of EXACTLY 2 vectors (A and C), not
    // (2A + C) / 3 as when nDocs is used as the weight.
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
    // halfvec stores 16-bit: rounding error around 1e-3; a weight mismatch would be much larger.
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
      joinedByDecision: 0,
      decisionsAsked: 0,
      decisionsFailed: 0,
      decisionsSkipped: 0,
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
    // As in a real run: new articles are processed in the previous run, articles older than 26 days are fetched later.
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

  test("chấm mọi cặp (tài liệu, chủ đề), bật hay tắt; bật tắt không chấm lại; chủ đề mới chỉ chấm cột mới", async () => {
    await addStory("LLM agents framework for language model tooling", "https://a.com/1");
    await addStory("Gardening tips for growing tomatoes", "https://c.com/z");
    await db.insert(topics).values({
      key: "agents",
      groupName: "AI",
      name: "Agent",
      embedText: "LLM agents framework",
    });
    await pickTopics(db, 1, ["agents"]);
    await addCustomTopic(db, 1, {
      label: "Làm vườn",
      description: "trồng cà chua",
      embedText: "gardening tomatoes",
    });
    const [agents, garden] = await listProfileTopics(db, 1);
    await setTopicActive(db, 1, garden?.id ?? 0, false);

    // Disabled topics are still embedded and scored: scores do not depend on what users turn on (D4).
    const out = await runProcess(deps());
    expect([out.topicsEmbedded, out.scored]).toEqual([2, 4]);
    const agentsScores = await db
      .select({ doc: docTopicScores.documentId, score: docTopicScores.score })
      .from(docTopicScores)
      .where(eq(docTopicScores.topicId, agents?.topicId ?? 0))
      .orderBy(asc(docTopicScores.documentId));
    expect(agentsScores[0]?.score ?? 0).toBeGreaterThan(agentsScores[1]?.score ?? 1);

    await setTopicActive(db, 1, garden?.id ?? 0, true);
    expect(await runProcess(deps())).toMatchObject({ topicsEmbedded: 0, scored: 0 });
    await addCustomTopic(db, 1, {
      label: "Ảnh",
      description: "ảnh",
      embedText: "image models",
    });
    expect(await runProcess(deps())).toMatchObject({ topicsEmbedded: 1, scored: 2 });
  });

  test("sửa chủ đề không đổi bảng sự kiện", async () => {
    await addStory("LLM agents framework for language model tooling", "https://a.com/1");
    await addStory("Gardening tips for growing tomatoes", "https://c.com/z");
    await runProcess(deps());
    const before = await db.select().from(eventDocuments).orderBy(asc(eventDocuments.documentId));
    await addCustomTopic(db, 1, {
      label: "Làm vườn",
      description: "trồng cà chua",
      embedText: "gardening tomatoes",
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

/**
 * Fake embedding can set an exact cosine: text containing `cos<x>` becomes a unit vector with cosine
 * exactly x against the vector of `cos1` (first two dimensions, the rest 0).
 */
const angleEmbedding: EmbeddingProvider = {
  provider: "fake",
  model: "angle",
  dimensions: EMBED_DIMENSIONS,
  async embed(texts) {
    return texts.map((t) => {
      const c = Number(/cos([\d.]+)/.exec(t)?.[1] ?? 0);
      const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
      v[0] = c;
      v[1] = Math.sqrt(1 - c * c);
      return v;
    });
  },
};

describe("gộp vùng xám bằng model quyết định", () => {
  /** How many times it was asked, and what state; returns `p` or throws. */
  function decider(p: number | Error) {
    const states: DecisionState[] = [];
    const calls: UsageEvent[] = [];
    const d = fakeDecision({
      answer: (q, _id, state) => {
        expect(q).toEqual({ type: "boolean", instructions: SAME_STORY_QUESTION });
        states.push(state);
        if (p instanceof Error) throw p;
        return p;
      },
      sink: async (e) => {
        calls.push(e);
      },
    });
    return { d, states, calls };
  }
  const gray = (d: ProcessDeps["decider"]): ProcessDeps => ({
    db,
    store,
    embedder: angleEmbedding,
    thresholds: { join: 0.9, windowDays: 7 },
    decider: d,
  });
  const twoStories = async (cos: number) => {
    await addStory("Seed story cos1", "https://a.com/1", "2026-09-27T10:00:00Z");
    await addStory(`Follow-up story cos${cos}`, "https://b.com/2", "2026-09-27T12:00:00Z");
  };
  const reasons = async () =>
    (
      await db
        .select({ reason: eventDocuments.reason, similarity: eventDocuments.similarity })
        .from(eventDocuments)
        .orderBy(asc(eventDocuments.documentId))
    ).map((r) => r.reason);

  test("cosine 0,87 và p ≥ 0,5: gộp, lý do 'decision', góp vào tâm; trạng thái như lúc đo", async () => {
    await twoStories(0.87);
    const { d, states, calls } = decider(0.7);
    const out = await runProcess(gray(d));
    expect(out).toMatchObject({ created: 1, joinedByDecision: 1, decisionsAsked: 1 });
    const links = await db.select().from(eventDocuments).orderBy(asc(eventDocuments.documentId));
    expect(links.map((l) => l.reason)).toEqual(["seed", "decision"]);
    expect(links[1]?.similarity ?? 0).toBeCloseTo(0.87, 2);
    const [ev] = await db.select().from(events);
    expect([ev?.nDocs, ev?.nVectors]).toEqual([2, 2]);
    expect(calls.map((c) => c.task)).toEqual(["decide_same_story"]);
    expect(states[0]).toEqual({
      item_a: {
        title: "Follow-up story cos0.87",
        source: "HN giả",
        date: "2026-09-27",
        excerpt: "Follow-up story cos0.87",
      },
      item_b: {
        title: "Seed story cos1",
        source: "HN giả",
        date: "2026-09-27",
        excerpt: "Seed story cos1",
      },
    });
  });

  test("cosine 0,87 và p < 0,5: mở sự kiện mới", async () => {
    await twoStories(0.87);
    const { d, states } = decider(0.3);
    const out = await runProcess(gray(d));
    expect(out).toMatchObject({ created: 2, joinedByDecision: 0, decisionsAsked: 1 });
    expect(states).toHaveLength(1);
    expect(await reasons()).toEqual(["seed", "seed"]);
  });

  test("cosine từ 0,9 gộp theo vector, không hỏi", async () => {
    await twoStories(0.92);
    const { d, states } = decider(0);
    const out = await runProcess(gray(d));
    expect(out).toMatchObject({ created: 1, joinedByVector: 1, decisionsAsked: 0 });
    expect(states).toHaveLength(0);
    expect(await reasons()).toEqual(["seed", "vector"]);
  });

  test("cosine dưới 0,85 không bao giờ hỏi", async () => {
    expect(DECISION_JOIN_LOW).toBe(0.85);
    await twoStories(0.84);
    const { d, states } = decider(1);
    const out = await runProcess(gray(d));
    expect(out).toMatchObject({ created: 2, decisionsAsked: 0 });
    expect(states).toHaveLength(0);
  });

  test("hỏi lỗi: không gộp, lượt process vẫn xong", async () => {
    await twoStories(0.87);
    const { d } = decider(new Error("Gateway 503"));
    const out = await runProcess(gray(d));
    expect(out).toMatchObject({ created: 2, joinedByDecision: 0, decisionsFailed: 1 });
    expect(await reasons()).toEqual(["seed", "seed"]);
  });

  test("nguồn tắt gộp theo vector (vectorJoin = false) thì không hỏi", async () => {
    await db.update(sources).set({ config: { vectorJoin: false } });
    await twoStories(0.87);
    const { d, states } = decider(1);
    const out = await runProcess(gray(d));
    expect(out.created).toBe(2);
    expect(states).toHaveLength(0);
  });

  test("events rebuild không hỏi khi không có cờ --decide; có cờ thì hỏi", async () => {
    await twoStories(0.87);
    const { d, states } = decider(0.9);
    const plain = await rebuildEvents(gray(d));
    expect(plain).toMatchObject({ created: 2, decisionsAsked: 0, decisionsSkipped: 1 });
    expect(states).toHaveLength(0);
    const decided = await rebuildEvents(gray(d), { decide: true });
    expect(decided).toMatchObject({ created: 1, joinedByDecision: 1, decisionsAsked: 1 });
    expect(states).toHaveLength(1);
    expect(await reasons()).toEqual(["seed", "decision"]);
  });
});
