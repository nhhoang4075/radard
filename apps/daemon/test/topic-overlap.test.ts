/**
 * Soát chủ đề gần giống trên DB test: dữ liệu dựng tay để biết trước tỉ lệ trùng tin. Mỗi chủ đề
 * là một trục của không gian vector; tin nằm giữa các trục thì cả các chủ đề đó cùng bắt. Embedding
 * và model quyết định đều giả, không gọi mạng. Tập so là 10 tin thay vì 300 cho gọn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeDecision } from "@radard/adapters/ai-fake";
import type { DecisionState, EmbeddingProvider } from "@radard/core";
import {
  createDatabase,
  dbUsageSink,
  docText,
  docTopicScores,
  documents,
  EMBED_DIMENSIONS,
  llmCalls,
  profile,
  profileTopics,
  runMigrations,
  sources,
  topics,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { scoreTopics } from "../src/jobs/process.ts";
import {
  checkTopicOverlap,
  englishName,
  OVERLAP_ASK_RATIO,
  RELATION_CRITERIA,
} from "../src/jobs/topic-overlap.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const MODEL = "test-model";
const NOW = new Date("2026-10-15T00:00:00Z");
const TOP_N = 10;
const DRAFT = { label: "Bản nháp", descriptionEn: "Draft topic: zero axis" };

/** Vector có trọng số 1 ở các trục `axes`. */
function vec(...axes: number[]): number[] {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  for (const a of axes) v[a] = (v[a] ?? 0) + 1;
  return v;
}

/** Embedder giả trả vector trục 0 cho bản nháp. */
const embedder: EmbeddingProvider = {
  provider: "stub",
  model: MODEL,
  dimensions: EMBED_DIMENSIONS,
  embed: async (texts) => texts.map(() => vec(0)),
};

let hn = 0;
let seq = 0;

async function addDoc(title: string, v: number[], daysAgo = 1): Promise<number> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
      externalId: String(id),
      url: `https://x.com/${id}`,
      urlCanonical: `https://x.com/${id}`,
      title,
      publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  await db.insert(docText).values({
    documentId: d?.id ?? 0,
    text: title,
    lang: "eng",
    embedding: v,
    embeddingModel: MODEL,
  });
  return d?.id ?? 0;
}

async function addTopicRow(
  label: string,
  axis: number,
  opts: { custom?: boolean; retired?: boolean; enabled?: boolean } = {},
): Promise<number> {
  const [t] = await db
    .insert(topics)
    .values({
      labelVi: label,
      descriptionEn: `Topic ${label}: axis ${axis}`,
      ...(opts.custom
        ? { origin: "custom", ownerProfileId: 1, descriptionUser: label }
        : { origin: "library", key: label, groupVi: "g" }),
      active: !opts.retired,
      embedding: vec(axis),
      embeddingModel: MODEL,
    })
    .returning({ id: topics.id });
  const id = t?.id ?? 0;
  if (opts.enabled !== undefined) {
    await db.insert(profileTopics).values({ topicId: id, active: opts.enabled });
  }
  return id;
}

/**
 * Tập so của bản nháp (trục 0) là đúng 10 tin có thành phần trục 0, theo thứ tự khớp giảm dần:
 * n1–n3 (chỉ trục 0), a1–a4 (trục 0 + 1), ab1–ab3 (trục 0 + 1 + 2). Trục 1 có thêm 3 tin riêng,
 * nên top 10 của trục 1 là 3 tin riêng + a + ab: trùng 7/10. Trục 2 có thêm 7 tin riêng: top 10 là
 * 7 tin riêng + ab: trùng 3/10, đúng ngưỡng hỏi. Một tin trục 0 cũ 40 ngày phải bị bỏ.
 */
async function seedDocs() {
  for (let i = 1; i <= 3; i++) await addDoc(`n${i}`, vec(0, 0, 0, 0, 0, 0, 0, 0, 0, 100 + i));
  for (let i = 1; i <= 4; i++) await addDoc(`a${i}`, vec(0, 1));
  for (let i = 1; i <= 3; i++) await addDoc(`ab${i}`, vec(0, 1, 2));
  for (let i = 1; i <= 3; i++) await addDoc(`only1-${i}`, vec(1));
  for (let i = 1; i <= 7; i++) await addDoc(`only2-${i}`, vec(2));
  for (let i = 1; i <= 10; i++) await addDoc(`only5-${i}`, vec(5));
  await addDoc("old", vec(0), 40);
}

const check = (decider: Parameters<typeof checkTopicOverlap>[0]["decider"] = null) =>
  checkTopicOverlap({ db, embedder, decider }, DRAFT, { topN: TOP_N, now: NOW });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate sources, profile, topics, documents, llm_calls restart identity cascade`,
  );
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  hn = s?.id ?? 0;
  await db.insert(profile).values({ description: "x" });
  await seedDocs();
});

afterAll(async () => {
  await db.$bun.close();
});

describe("checkTopicOverlap: tỉ lệ trùng tin", () => {
  test("tỉ lệ đúng, ngưỡng gồm 0,3, chủ đề tự thêm đang tắt vẫn được so, chủ đề đã rút thì không", async () => {
    const a = await addTopicRow("A", 1, { enabled: true });
    const b = await addTopicRow("B", 2, { custom: true, enabled: false });
    await addTopicRow("D", 5);
    await addTopicRow("E", 1, { retired: true });
    await scoreTopics(db, MODEL);

    const res = await check();
    expect(res.docs).toBe(TOP_N);
    expect(res.model).toBeNull();
    expect(OVERLAP_ASK_RATIO).toBe(0.3);
    expect(res.candidates).toEqual([
      {
        topicId: a,
        label: "A",
        origin: "library",
        enabled: true,
        ratio: 0.7,
        relation: null,
        probability: null,
        shared: ["a1", "a2", "a3"],
        onlyNew: ["n1", "n2", "n3"],
      },
      {
        topicId: b,
        label: "B",
        origin: "custom",
        enabled: false,
        ratio: 0.3,
        relation: null,
        probability: null,
        shared: ["ab1", "ab2", "ab3"],
        onlyNew: ["n1", "n2", "n3"],
      },
    ]);
  });

  test("chủ đề chưa được chấm thì tính cosine, ra cùng tỉ lệ; giữ tối đa 3, tỉ lệ cao trước", async () => {
    const a = await addTopicRow("A", 1);
    await addTopicRow("B", 2);
    const f = await addTopicRow("F", 1);
    await scoreTopics(db, MODEL);
    const c = await addTopicRow("C", 1); // thêm sau khi chấm: không có doc_topic_scores
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(docTopicScores)
      .where(eq(docTopicScores.topicId, c));
    expect(n?.n).toBe(0);

    const res = await check();
    expect(res.candidates.map((x) => [x.topicId, x.ratio])).toEqual([
      [a, 0.7],
      [f, 0.7],
      [c, 0.7],
    ]);
    expect(res.candidates[2]?.shared).toEqual(["a1", "a2", "a3"]);
  });

  test("không chủ đề nào từ 0,3 thì không hỏi model", async () => {
    await addTopicRow("D", 5);
    await scoreTopics(db, MODEL);
    let asked = 0;
    const decider = fakeDecision({
      answer: () => {
        asked++;
        return "same";
      },
    });
    const res = await check(decider);
    expect(res.candidates).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe("checkTopicOverlap: hỏi quan hệ", () => {
  test("một lời gọi, mỗi chủ đề một câu choice; ghi llm_calls kèm chi phí", async () => {
    const a = await addTopicRow("A", 1);
    const b = await addTopicRow("B", 2);
    await scoreTopics(db, MODEL);
    const states: DecisionState[] = [];
    const decider = fakeDecision({
      answer: (q, id, state) => {
        states.push(state);
        expect(q.type).toBe("choice");
        if (q.type === "choice") expect(q.criteria).toEqual(RELATION_CRITERIA);
        return id === `topic_${a}`
          ? {
              choice: "narrower",
              probabilities: { same: 0.1, narrower: 0.85, broader: 0, different: 0.05 },
            }
          : "different";
      },
      sink: dbUsageSink(db),
      costUsd: 0.0000213,
    });
    const res = await check(decider);
    expect(res.model).toBe("fake-decision");
    expect(res.candidates.map((c) => [c.topicId, c.relation, c.probability])).toEqual([
      [a, "narrower", 0.85],
      [b, "different", 1],
    ]);
    // Hai câu hỏi chung một trạng thái: chủ đề có sẵn nằm theo khoá câu hỏi.
    expect(states[0]).toEqual({
      new_topic: { name: "Draft topic", description: DRAFT.descriptionEn },
      existing_topics: {
        [`topic_${a}`]: { name: "Topic A", description: "Topic A: axis 1" },
        [`topic_${b}`]: { name: "Topic B", description: "Topic B: axis 2" },
      },
    });
    const calls = await db.select().from(llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ task: "topic_overlap", costUsd: 0.0000213, ok: true });
  });

  test("một chủ đề gần: trạng thái và câu hỏi đúng như đã thử", async () => {
    await addTopicRow("A", 1);
    await scoreTopics(db, MODEL);
    const seen: { state: DecisionState; instructions: string }[] = [];
    const decider = fakeDecision({
      answer: (q, _id, state) => {
        seen.push({ state, instructions: q.instructions });
        return "same";
      },
    });
    await check(decider);
    expect(seen).toEqual([
      {
        state: {
          new_topic: { name: "Draft topic", description: DRAFT.descriptionEn },
          existing_topic: { name: "Topic A", description: "Topic A: axis 1" },
        },
        instructions:
          "How does the new topic relate to the existing topic, in terms of which news articles each would match?",
      },
    ]);
  });

  test("model quyết định lỗi thì vẫn trả tỉ lệ, quan hệ trống", async () => {
    await addTopicRow("A", 1);
    await scoreTopics(db, MODEL);
    const decider = fakeDecision({ answer: () => "không-có" });
    const res = await check(decider);
    expect(res.model).toBeNull();
    expect(res.candidates.map((c) => [c.ratio, c.relation, c.probability])).toEqual([
      [0.7, null, null],
    ]);
  });
});

describe("englishName", () => {
  test("lấy phần trước dấu hai chấm; không có thì dùng tên dự phòng", () => {
    expect(englishName("AI agents: LLM agents that plan", "Agent AI")).toBe("AI agents");
    expect(englishName("Launches and new features of AI apps", "Trợ lý")).toBe("Trợ lý");
  });
});
