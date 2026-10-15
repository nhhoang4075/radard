/**
 * Soát chủ đề gần giống trên DB test: dữ liệu dựng tay để biết trước tỉ lệ trùng tin. Mỗi chủ đề
 * là một trục của không gian vector; tin nằm giữa các trục thì cả các chủ đề đó cùng bắt. Embedding
 * và model quyết định đều giả, không gọi mạng; model giả quyết định quan hệ theo id chủ đề. Tập so
 * là 10 tin thay vì 300 cho gọn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type FakeDecisionReply, fakeDecision } from "@radard/adapters/ai-fake";
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
  HUB_MIN_TOPICS,
  MAX_QUESTIONS_PER_CALL,
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

let embedCalls = 0;

/** Embedder giả trả vector trục 0 cho bản nháp, đếm số lời gọi. */
const embedder: EmbeddingProvider = {
  provider: "stub",
  model: MODEL,
  dimensions: EMBED_DIMENSIONS,
  embed: async (texts) => {
    embedCalls++;
    return texts.map(() => vec(0));
  },
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
 * 7 tin riêng + ab: trùng 3/10. ab nằm trong top 10 của cả trục 1 lẫn trục 2. Trục 5 không chung
 * tin nào. Một tin trục 0 cũ 40 ngày phải bị bỏ.
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

/** Model quyết định giả: quan hệ theo id chủ đề (câu hỏi `topic_<id>`), mặc định "khác". */
function deciderFor(
  answers: Record<number, FakeDecisionReply>,
  seen: { id: string; state: DecisionState; instructions: string }[] = [],
) {
  return fakeDecision({
    answer: (q, id, state) => {
      seen.push({ id, state, instructions: q.instructions });
      if (q.type === "choice") expect(q.criteria).toEqual(RELATION_CRITERIA);
      return answers[Number(id.replace("topic_", ""))] ?? "different";
    },
    sink: dbUsageSink(db),
    costUsd: 0.0000213,
  });
}

const relation = (choice: string, p: number) => ({
  choice,
  probabilities: { same: 0, narrower: 0, broader: 0, different: 0, [choice]: p },
});

const check = (
  decider: Parameters<typeof checkTopicOverlap>[0]["decider"],
  opts: { hubMinTopics?: number } = {},
) => checkTopicOverlap({ db, embedder, decider }, DRAFT, { topN: TOP_N, now: NOW, ...opts });

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
  embedCalls = 0;
});

afterAll(async () => {
  await db.$bun.close();
});

describe("checkTopicOverlap: model quyết định", () => {
  test("hỏi mọi chủ đề (kể cả tự thêm đang tắt, trừ chủ đề đã rút); ứng viên là chủ đề không khác, trùng > hẹp > rộng rồi xác suất", async () => {
    const a = await addTopicRow("A", 1, { enabled: true });
    const b = await addTopicRow("B", 2);
    const c = await addTopicRow("C", 2, { custom: true, enabled: false });
    await addTopicRow("D", 5);
    await addTopicRow("E", 1, { retired: true });
    await scoreTopics(db, MODEL);

    const res = await check(
      deciderFor({
        [a]: relation("narrower", 0.9),
        [b]: relation("broader", 0.8),
        [c]: relation("narrower", 0.95),
      }),
    );
    expect(res).toMatchObject({ ran: true, asked: 4, model: "fake-decision", docs: TOP_N });
    expect(res.candidates).toEqual([
      {
        topicId: c,
        label: "C",
        origin: "custom",
        enabled: false,
        relation: "narrower",
        probability: 0.95,
        ratio: 0.3,
        shared: ["ab1", "ab2", "ab3"],
        onlyNew: ["n1", "n2", "n3"],
      },
      {
        topicId: a,
        label: "A",
        origin: "library",
        enabled: true,
        relation: "narrower",
        probability: 0.9,
        ratio: 0.7,
        shared: ["a1", "a2", "a3"],
        onlyNew: ["n1", "n2", "n3"],
      },
      {
        topicId: b,
        label: "B",
        origin: "library",
        enabled: false,
        relation: "broader",
        probability: 0.8,
        ratio: 0.3,
        shared: ["ab1", "ab2", "ab3"],
        onlyNew: ["n1", "n2", "n3"],
      },
    ]);
  });

  test("một lời gọi, trạng thái chung có mọi chủ đề theo khoá câu hỏi; ghi llm_calls kèm chi phí", async () => {
    const a = await addTopicRow("A", 1);
    const b = await addTopicRow("B", 2);
    await scoreTopics(db, MODEL);
    const seen: { id: string; state: DecisionState; instructions: string }[] = [];
    await check(deciderFor({ [a]: "same" }, seen));
    expect(seen.map((s) => s.instructions)).toEqual([
      `How does the new topic relate to the existing topic topic_${a}, in terms of which news articles each would match?`,
      `How does the new topic relate to the existing topic topic_${b}, in terms of which news articles each would match?`,
    ]);
    expect(seen[0]?.state).toEqual({
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

  test("mọi chủ đề đều khác thì không có ứng viên và không cần embed", async () => {
    await addTopicRow("A", 1);
    await addTopicRow("D", 5);
    await scoreTopics(db, MODEL);
    const res = await check(deciderFor({}));
    expect(res).toEqual({ ran: true, candidates: [], asked: 2, model: "fake-decision", docs: 0 });
    expect(embedCalls).toBe(0);
  });

  test("không có model quyết định: báo chưa soát được, không có ứng viên (không lọc bằng tỉ lệ)", async () => {
    await addTopicRow("A", 1);
    await scoreTopics(db, MODEL);
    const res = await check(null);
    expect(res).toEqual({ ran: false, candidates: [], asked: 1, model: null, docs: 0 });
  });

  test("model quyết định lỗi cũng là chưa soát được", async () => {
    await addTopicRow("A", 1);
    await scoreTopics(db, MODEL);
    const res = await check(fakeDecision({ answer: () => "không-có" }));
    expect(res.ran).toBe(false);
    expect(res.candidates).toEqual([]);
  });

  test("quá 30 chủ đề thì chia lô ≤ 30 câu, mỗi lô một trạng thái riêng", async () => {
    expect(MAX_QUESTIONS_PER_CALL).toBe(30);
    const ids: number[] = [];
    for (let i = 0; i < 65; i++) ids.push(await addTopicRow(`T${i}`, 200 + i));
    const last = ids[64] ?? 0;
    const seen: { id: string; state: DecisionState; instructions: string }[] = [];
    const res = await check(deciderFor({ [last]: "same" }, seen));
    const states = [...new Set(seen.map((s) => s.state))] as {
      existing_topics: Record<string, unknown>;
    }[];
    expect(states.map((s) => Object.keys(s.existing_topics).length)).toEqual([30, 30, 5]);
    expect(await db.select().from(llmCalls)).toHaveLength(3);
    expect(res.asked).toBe(65);
    expect(res.candidates.map((c) => [c.topicId, c.relation])).toEqual([[last, "same"]]);
  });
});

describe("checkTopicOverlap: bằng chứng", () => {
  test("tin ví dụ bỏ tin chung chung (trong top N của nhiều chủ đề thư viện); tỉ lệ giữ nguyên", async () => {
    expect(HUB_MIN_TOPICS).toBe(6);
    const a = await addTopicRow("A", 1);
    const b = await addTopicRow("B", 2);
    await scoreTopics(db, MODEL);
    // ab1–ab3 nằm trong top 10 của cả A lẫn B: với ngưỡng 2 chủ đề thì là tin chung chung.
    const res = await check(deciderFor({ [a]: "same", [b]: "narrower" }), { hubMinTopics: 2 });
    expect(res.candidates.map((c) => [c.topicId, c.ratio, c.shared, c.onlyNew])).toEqual([
      [a, 0.7, ["a1", "a2", "a3"], ["n1", "n2", "n3"]],
      [b, 0.3, [], ["n1", "n2", "n3"]],
    ]);
  });

  test("chủ đề chưa được chấm thì tính cosine, ra cùng tỉ lệ", async () => {
    await scoreTopics(db, MODEL);
    const c = await addTopicRow("C", 1); // thêm sau khi chấm: không có doc_topic_scores
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(docTopicScores)
      .where(eq(docTopicScores.topicId, c));
    expect(n?.n).toBe(0);
    const res = await check(deciderFor({ [c]: "same" }));
    expect(res.candidates.map((x) => [x.topicId, x.ratio, x.shared])).toEqual([
      [c, 0.7, ["a1", "a2", "a3"]],
    ]);
  });
});

describe("englishName", () => {
  test("lấy phần trước dấu hai chấm; không có thì dùng tên dự phòng", () => {
    expect(englishName("AI agents: LLM agents that plan", "Agent AI")).toBe("AI agents");
    expect(englishName("Launches and new features of AI apps", "Trợ lý")).toBe("Trợ lý");
  });
});
