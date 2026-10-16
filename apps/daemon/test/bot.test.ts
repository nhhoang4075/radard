/** Phía lõi của lệnh chọn chủ đề (`topicHandlers`) và lệnh /profile (`profileHandlers`) trên DB test. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeDecision, fakeLlm } from "@radard/adapters/ai-fake";
import { createDatabase, profile, runMigrations, topics } from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { describeReader, readProfile } from "../src/jobs/profile.ts";
import {
  addCustomTopic,
  listLibrary,
  listProfileTopics,
  pickTopics,
  seedLibrary,
} from "../src/jobs/topics.ts";
import { type BotDeps, profileHandlers, topicHandlers } from "../src/roles/bot.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const h = topicHandlers({ db, embedder: null, llm: null, decider: null });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate profile, topics restart identity cascade`);
  await db.insert(profile).values({ promptContext: "x" });
  await seedLibrary(db);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("topicHandlers", () => {
  test("danh sách = thư viện (theo thứ tự) + chủ đề tự thêm; bật tắt cả hai loại", async () => {
    await addCustomTopic(db, {
      label: "Postgres cho AI",
      description: "pgvector",
      embedText: "pgvector",
    });
    const before = await h.list();
    expect(before[0]).toMatchObject({
      key: "l:1",
      label: "Model AI: phát hành và hành vi",
      chosen: false,
    });
    const custom = before.at(-1);
    expect(custom).toMatchObject({ label: "Postgres cho AI", chosen: true });
    expect(custom?.key).toMatch(/^c:\d+$/);

    expect(await h.toggle("l:1")).toBe(true);
    expect(await h.toggle(custom?.key ?? "")).toBe(false);
    const after = await h.list();
    expect(after[0]?.chosen).toBe(true);
    expect(after.at(-1)?.chosen).toBe(false);
  });

  test("không có LLM thì báo lỗi rõ ràng khi tự thêm", async () => {
    await expect(h.describe("x", "y")).rejects.toThrow("AI_GATEWAY_API_KEY");
  });
});

const OLD_CONTEXT = "AI engineering news: agents, RAG, TypeScript, Postgres.";
const NEW_CONTEXT =
  "The reader is an AI software engineer who builds LLM-integrated systems and agents with Python, TypeScript and Postgres, and wants to learn more about algorithms and machine learning such as ranking, retrieval and clustering.";

/** Xác suất "có" theo khoá thư viện; khoá không có thì 0,1 (không gợi ý). */
const PROBS: Record<string, number> = {
  agents: 0.93,
  llm_apps: 0.95,
  training: 0.93,
  ai_infra: 0.92,
  llm_models: 0.88,
  ai_coding: 0.87,
  ai_safety: 0.74,
  ml_foundations: 0.7,
  multimodal: 0.69,
};

const NEW_TOPIC = {
  labelVi: "Ngôn ngữ, runtime và cơ sở dữ liệu",
  descriptionEn:
    "Programming languages, runtimes and databases: Python, TypeScript, Bun, Node.js releases, PostgreSQL, pgvector, query performance, ORMs and drivers",
  why: "Bạn làm việc hằng ngày với Python, TypeScript và Postgres.",
};

async function idToKey(): Promise<Map<number, string>> {
  return new Map((await listLibrary(db)).map((t) => [t.id, t.key]));
}

function deps(over: Partial<BotDeps> = {}): BotDeps {
  return { db, embedder: null, llm: null, decider: null, ...over };
}

function fakes(keys: Map<number, string>) {
  const llmTasks: string[] = [];
  const llm = fakeLlm({
    reply: (_prompt, system) => {
      if (system?.includes("reader profile")) {
        llmTasks.push("profile");
        return `"${NEW_CONTEXT}"`;
      }
      llmTasks.push("propose");
      return JSON.stringify([NEW_TOPIC]);
    },
  });
  const decider = fakeDecision({
    answer: (_q, id) => PROBS[keys.get(Number(id.replace("topic_", ""))) ?? ""] ?? 0.1,
  });
  return { llm, decider, llmTasks };
}

describe("profileHandlers", () => {
  beforeEach(async () => {
    await db.update(profile).set({ promptContext: OLD_CONTEXT });
  });

  test("chưa tự viết: get trả lời người dùng trống và bối cảnh cũ", async () => {
    const p = profileHandlers(deps(), () => {});
    expect(await p.get()).toEqual({ description: null, promptContext: OLD_CONTEXT });
  });

  test("sửa mô tả: lưu lời người dùng và bối cảnh tiếng Anh LLM viết", async () => {
    const { llm, llmTasks } = fakes(await idToKey());
    const p = profileHandlers(deps({ llm }), () => {});
    expect(await p.saveDescription("  Mình là kỹ sư AI  ")).toEqual({ rewritten: true });
    expect(await readProfile(db)).toEqual({
      description: "Mình là kỹ sư AI",
      promptContext: NEW_CONTEXT,
    });
    expect(llmTasks).toEqual(["profile"]);
  });

  test("thiếu LLM: vẫn lưu lời người dùng, giữ bối cảnh cũ", async () => {
    const p = profileHandlers(deps(), () => {});
    expect(await p.saveDescription("Mình là kỹ sư AI")).toEqual({ rewritten: false });
    expect(await readProfile(db)).toEqual({
      description: "Mình là kỹ sư AI",
      promptContext: OLD_CONTEXT,
    });
  });

  test("LLM trả câu hỏng: giữ bối cảnh cũ; chưa có hồ sơ thì tạo", async () => {
    await db.execute(sql`truncate profile cascade`);
    const llm = fakeLlm({ reply: () => "ok" });
    const p = profileHandlers(deps({ llm }), () => {});
    expect(await p.saveDescription("Mình là kỹ sư AI")).toEqual({ rewritten: false });
    expect(await readProfile(db)).toEqual({ description: "Mình là kỹ sư AI", promptContext: "" });
    await expect(describeReader(llm, "x")).rejects.toThrow();
  });

  test("gợi ý: tích sẵn mức nên theo dõi; chủ đề đang bật luôn tích; không gợi ý thì không hiện", async () => {
    const keys = await idToKey();
    // Đang bật từ trước: một chủ đề mức "có thể quan tâm" và một chủ đề không được gợi ý.
    await pickTopics(db, ["multimodal", "robotics"]);
    const { llm, decider } = fakes(keys);
    const p = profileHandlers(deps({ llm, decider }), () => {});
    const s = await p.suggest();
    if (!s) throw new Error("không có gợi ý");
    const shown = s.topics.map((t) => [keys.get(Number(t.key.slice(2))), t.tier, t.checked]);
    expect(shown).toEqual([
      ["llm_apps", "preselect", true],
      ["training", "preselect", true],
      ["agents", "preselect", true],
      ["ai_infra", "preselect", true],
      ["llm_models", "preselect", true],
      ["ai_coding", "preselect", true],
      ["ai_safety", "maybe", false],
      ["ml_foundations", "maybe", false],
      ["multimodal", "maybe", true],
    ]);
    expect(s.newTopics).toEqual([
      { label: NEW_TOPIC.labelVi, why: NEW_TOPIC.why, embedText: NEW_TOPIC.descriptionEn },
    ]);
  });

  test("gợi ý dựa trên bối cảnh đang lưu; thiếu model ra quyết định thì null", async () => {
    const seen: string[] = [];
    const decider = fakeDecision({
      answer: (_q, _id, state) => {
        seen.push(String((state as { reader: string }).reader));
        return 0.9;
      },
    });
    await profileHandlers(deps({ decider }), () => {}).suggest();
    expect(new Set(seen)).toEqual(new Set([OLD_CONTEXT]));
    expect(await profileHandlers(deps(), () => {}).suggest()).toBeNull();
  });

  test("Lưu: bật chủ đề tích, tắt chủ đề bỏ tích, chỉ trong các chủ đề được hiện", async () => {
    const keys = await idToKey();
    const id = (k: string) => [...keys].find(([, v]) => v === k)?.[0];
    await pickTopics(db, ["robotics", "ai_safety"]);
    let refreshed = 0;
    const p = profileHandlers(deps(), () => refreshed++);
    const n = await p.apply([`l:${id("agents")}`, `l:${id("llm_apps")}`], [`l:${id("ai_safety")}`]);
    const chosen = (await listLibrary(db)).filter((t) => t.chosen).map((t) => t.key);
    // robotics không hiện trong gợi ý: giữ nguyên.
    expect(new Set(chosen)).toEqual(new Set(["agents", "llm_apps", "robotics"]));
    expect(n).toBe(3);
    expect(refreshed).toBe(1);
    // Lưu lại y như cũ: không bật mới gì, không làm mới.
    await p.apply([`l:${id("agents")}`], [`l:${id("ai_safety")}`]);
    expect(refreshed).toBe(1);
  });

  test("Thêm chủ đề mới: chủ đề tự thêm đang bật, mô tả là câu đã hiện cho người dùng", async () => {
    let refreshed = 0;
    const p = profileHandlers(deps(), () => refreshed++);
    await p.addProposed({
      label: NEW_TOPIC.labelVi,
      why: NEW_TOPIC.why,
      embedText: NEW_TOPIC.descriptionEn,
    });
    const [t] = await db.select().from(topics).where(eq(topics.origin, "custom"));
    expect(t).toMatchObject({
      name: NEW_TOPIC.labelVi,
      description: `${NEW_TOPIC.labelVi}: ${NEW_TOPIC.why}`,
      embedText: NEW_TOPIC.descriptionEn,
    });
    const mine = (await listProfileTopics(db)).find((x) => x.topicId === t?.id);
    expect(mine?.active).toBe(true);
    expect(refreshed).toBe(1);
    expect(await p.apply([], [])).toBe(1);
    await expect(
      p.addProposed({ label: NEW_TOPIC.labelVi, why: "x", embedText: "y" }),
    ).rejects.toThrow("đã có chủ đề");
  });
});
