/**
 * Gợi ý chủ đề trên DB test: model quyết định và LLM đều giả, không gọi mạng. Model quyết định giả
 * trả xác suất theo id chủ đề cho câu có/không (chấm thư viện), và quan hệ theo tên đề xuất cho câu
 * `choice` (soát chủ đề gần giống).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type FakeDecisionReply, fakeDecision, fakeLlm } from "@radard/adapters/ai-fake";
import type { DecisionState, EmbeddingProvider } from "@radard/core";
import {
  createDatabase,
  dbUsageSink,
  EMBED_DIMENSIONS,
  llmCalls,
  profile,
  runMigrations,
  topics,
} from "@radard/db";
import { sql } from "drizzle-orm";
import {
  MAYBE_MIN,
  PRESELECT_MIN,
  parseProposals,
  type SuggestDeps,
  suggestTopics,
} from "../src/jobs/topic-suggest.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const MODEL = "test-model";
const READER = "Backend engineer adding LLM features";

const embedder: EmbeddingProvider = {
  provider: "stub",
  model: MODEL,
  dimensions: EMBED_DIMENSIONS,
  embed: async (texts) => texts.map(() => new Array<number>(EMBED_DIMENSIONS).fill(0.01)),
};

async function addLibrary(
  key: string,
  opts: { retired?: boolean; label?: string } = {},
): Promise<number> {
  const [t] = await db
    .insert(topics)
    .values({
      key,
      groupName: "g",
      name: opts.label ?? `Nhãn ${key}`,
      embedText: `Topic ${key}: things about ${key}`,
      origin: "library",
      active: !opts.retired,
      embedding: new Array<number>(EMBED_DIMENSIONS).fill(0.01),
      embeddingModel: MODEL,
    })
    .returning({ id: topics.id });
  return t?.id ?? 0;
}

interface Seen {
  state: DecisionState;
  instructions: string;
  id: string;
}

/**
 * Model quyết định giả: câu có/không theo id chủ đề (`probs`), câu quan hệ theo tên tiếng Anh của
 * đề xuất (`relations`, mặc định "khác").
 */
function decider(
  probs: Record<number, number>,
  relations: Record<string, Record<number, FakeDecisionReply>> = {},
  seen: Seen[] = [],
) {
  const d = fakeDecision({
    answer: (q, id, state) => {
      seen.push({ state, instructions: q.instructions, id });
      const topicId = Number(id.replace("topic_", ""));
      if (q.type === "boolean") return probs[topicId] ?? 0;
      const name = (state as { new_topic: { name: string } }).new_topic.name;
      return relations[name]?.[topicId] ?? "different";
    },
    sink: dbUsageSink(db),
  });
  return d;
}

const llmReplying = (...replies: string[]) => {
  const prompts: { prompt: string; system?: string }[] = [];
  let i = 0;
  const llm = fakeLlm({
    reply: (prompt, system) => {
      prompts.push({ prompt, system });
      return replies[Math.min(i++, replies.length - 1)] ?? "";
    },
    sink: dbUsageSink(db),
  });
  return { llm, prompts };
};

const proposal = (name: string, topicName: string) => ({
  name,
  embedText: `${topicName}: payment fraud detection, transaction risk scoring, anti money laundering models, credit scoring with machine learning, KYC automation`,
  why: "Bạn làm ở công ty fintech.",
});

/** Dạng LLM trả về: khoá trên dây giữ nguyên `labelVi`/`descriptionEn` (chỉ cột DB đổi tên). */
const wire = (p: ReturnType<typeof proposal>) => ({
  labelVi: p.name,
  descriptionEn: p.embedText,
  why: p.why,
});

const deps = (over: Partial<SuggestDeps>): SuggestDeps => ({
  db,
  decider: null,
  llm: null,
  embedder,
  ...over,
});

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate profile, topics, llm_calls restart identity cascade`);
  await db.insert(profile).values({ promptContext: READER });
});

afterAll(async () => {
  await db.$bun.close();
});

describe("suggestTopics: chấm thư viện", () => {
  test("chia ba mức đúng ở ranh giới, cao trước; bỏ chủ đề đã rút; một lời gọi", async () => {
    expect([PRESELECT_MIN, MAYBE_MIN]).toEqual([0.85, 0.58]);
    const a = await addLibrary("a");
    const b = await addLibrary("b");
    const c = await addLibrary("c");
    const d = await addLibrary("d");
    const e = await addLibrary("e");
    const retired = await addLibrary("old", { retired: true });
    const seen: Seen[] = [];
    const res = await suggestTopics(
      deps({
        decider: decider({ [a]: 0.85, [b]: 0.849, [c]: 0.58, [d]: 0.579, [e]: 0.95 }, {}, seen),
      }),
      READER,
    );
    expect(res.ran).toEqual({ library: true, newTopics: false });
    expect(res.preselect.map((s) => [s.key, s.probability])).toEqual([
      ["e", 0.95],
      ["a", 0.85],
    ]);
    expect(res.maybe.map((s) => [s.key, s.probability])).toEqual([
      ["b", 0.849],
      ["c", 0.58],
    ]);
    expect(res.notSuggested).toEqual([
      { topicId: d, key: "d", label: "Nhãn d", probability: 0.579 },
    ]);
    expect(seen.some((s) => s.id === `topic_${retired}`)).toBe(false);
    expect(seen).toHaveLength(5);
    expect(seen[0]?.state).toEqual({ reader: READER });
    expect(seen[0]?.instructions).toBe(
      'Would this reader want news about "Topic a" in a daily AI news digest? Topic: Topic a: things about a',
    );
    const calls = await db.select().from(llmCalls);
    expect(calls.map((c) => c.task)).toEqual(["suggest_topics"]);
  });

  test("thiếu model quyết định: không chấm, cả ba mức trống", async () => {
    await addLibrary("a");
    const res = await suggestTopics(deps({}), READER);
    expect(res.ran).toEqual({ library: false, newTopics: false });
    expect([res.preselect, res.maybe, res.notSuggested]).toEqual([[], [], []]);
    expect(await db.select().from(llmCalls)).toHaveLength(0);
  });

  test("model quyết định lỗi: báo chưa chấm kèm lỗi, không ném", async () => {
    await addLibrary("a");
    const broken = fakeDecision({
      answer: () => {
        throw new Error("hết giờ");
      },
    });
    const res = await suggestTopics(deps({ decider: broken }), READER);
    expect(res.ran.library).toBe(false);
    expect(res.errors.library).toContain("hết giờ");
  });

  test("lời mô tả trống thì lỗi", async () => {
    await expect(suggestTopics(deps({}), "  ")).rejects.toThrow("trống");
  });
});

describe("suggestTopics: chủ đề mới", () => {
  test("đề xuất hợp lệ: lời nhắc có lời mô tả và thư viện; bỏ đề xuất hẹp hơn hay trùng chủ đề có sẵn", async () => {
    const a = await addLibrary("a", { label: "Ứng dụng LLM" });
    const b = await addLibrary("b");
    const { llm, prompts } = llmReplying(
      JSON.stringify([
        wire(proposal("AI cho tài chính", "AI in finance")),
        wire(proposal("Chống gian lận", "Fraud detection")),
      ]),
    );
    const res = await suggestTopics(
      deps({
        llm,
        decider: decider(
          { [a]: 0.9, [b]: 0.3 },
          {
            "AI in finance": {
              [a]: {
                choice: "narrower",
                probabilities: { same: 0, narrower: 0.7, broader: 0, different: 0.3 },
              },
            },
            "Fraud detection": { [b]: "same" },
          },
        ),
      }),
      READER,
    );
    expect(res.ran).toEqual({ library: true, newTopics: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.prompt).toContain(READER);
    expect(prompts[0]?.prompt).toContain("- Ứng dụng LLM | Topic a: things about a");
    // Đề xuất hẹp hơn hay trùng chủ đề có sẵn đều bị bỏ: chỉ giữ chủ đề khác mọi chủ đề có sẵn.
    expect(res.newTopics).toHaveLength(0);
    expect(res.dropped).toEqual([
      {
        name: "AI cho tài chính",
        embedText: proposal("", "AI in finance").embedText,
        relatedTo: { topicId: a, label: "Ứng dụng LLM", relation: "narrower", probability: 0.7 },
      },
      {
        name: "Chống gian lận",
        embedText: proposal("", "Fraud detection").embedText,
        relatedTo: { topicId: b, label: "Nhãn b", relation: "same", probability: 1 },
      },
    ]);
    const tasks = (await db.select().from(llmCalls)).map((c) => c.task).sort();
    expect(tasks).toContain("suggest_new_topics");
    expect(tasks.filter((t) => t === "topic_overlap")).toHaveLength(2);
  });

  test("JSON trong khối ```json vẫn đọc được; [] là thư viện đã đủ", async () => {
    await addLibrary("a");
    const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify([wire(proposal("AI tài chính", "AI in finance"))])}\n\`\`\``;
    const one = await suggestTopics(deps({ llm: llmReplying(fenced).llm }), READER);
    expect(one.newTopics.map((t) => [t.name, t.overlapChecked])).toEqual([["AI tài chính", false]]);
    const none = await suggestTopics(deps({ llm: llmReplying("[]").llm }), READER);
    expect(none.ran.newTopics).toBe(true);
    expect(none.newTopics).toEqual([]);
  });

  test("câu trả lời hỏng thì thử lại một lần; lần hai đúng thì dùng", async () => {
    await addLibrary("a");
    const { llm, prompts } = llmReplying(
      "không phải JSON",
      JSON.stringify([wire(proposal("AI tài chính", "AI in finance"))]),
    );
    const res = await suggestTopics(deps({ llm }), READER);
    expect(prompts).toHaveLength(2);
    expect(res.newTopics).toHaveLength(1);
  });

  test("hỏng cả hai lần: không ném, báo chưa đề xuất kèm lỗi; phần thư viện vẫn chạy", async () => {
    const a = await addLibrary("a");
    const { llm, prompts } = llmReplying("[{broken", "vẫn hỏng");
    const res = await suggestTopics(deps({ llm, decider: decider({ [a]: 0.9 }) }), READER);
    expect(prompts).toHaveLength(2);
    expect(res.ran).toEqual({ library: true, newTopics: false });
    expect(res.newTopics).toEqual([]);
    expect(res.errors.newTopics).toBeTruthy();
    expect(res.preselect.map((s) => s.key)).toEqual(["a"]);
  });

  test("thiếu LLM: không đề xuất", async () => {
    const res = await suggestTopics(deps({}), READER);
    expect(res.ran.newTopics).toBe(false);
    expect(res.newTopics).toEqual([]);
  });

  test("thiếu embedder: giữ đề xuất nhưng báo chưa soát gần giống", async () => {
    const a = await addLibrary("a");
    const res = await suggestTopics(
      deps({
        embedder: null,
        llm: llmReplying(JSON.stringify([wire(proposal("AI tài chính", "AI in finance"))])).llm,
        decider: decider({ [a]: 0.9 }, { "AI in finance": { [a]: "same" } }),
      }),
      READER,
    );
    expect(res.newTopics.map((t) => [t.name, t.overlapChecked])).toEqual([["AI tài chính", false]]);
  });
});

describe("parseProposals", () => {
  test("bỏ mục thiếu trường, câu mô tả quá ngắn hay không có dấu hai chấm; tối đa 3", () => {
    const good = (n: number) => wire(proposal(`Chủ đề ${n}`, `Topic ${n}`));
    const reply = JSON.stringify([
      { labelVi: "Thiếu why", descriptionEn: good(0).descriptionEn },
      { ...good(0), descriptionEn: "Short: too few words" },
      { ...good(0), descriptionEn: good(0).descriptionEn.replace(":", "") },
      good(1),
      good(2),
      good(3),
      good(4),
    ]);
    expect(parseProposals(reply).map((p) => p.name)).toEqual(["Chủ đề 1", "Chủ đề 2", "Chủ đề 3"]);
  });

  test("không có mảng thì lỗi", () => {
    expect(() => parseProposals('{"labelVi": "x"}')).toThrow();
    expect(() => parseProposals("không có gì")).toThrow();
  });

  test("tên trùng chủ đề thư viện thì bỏ", async () => {
    await addLibrary("a", { label: "Agent AI" });
    const res = await suggestTopics(
      deps({ llm: llmReplying(JSON.stringify([wire(proposal("agent ai", "Agents"))])).llm }),
      READER,
    );
    expect(res.newTopics).toEqual([]);
  });
});
