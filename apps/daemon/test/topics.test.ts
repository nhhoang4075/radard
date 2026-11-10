/**
 * Test tích hợp chủ đề trên `radard_test`: thư viện, chọn, tự thêm, bật tắt, embed. Embedding
 * và LLM đều GIẢ, không gọi mạng.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeEmbedding, fakeLlm } from "@radard/adapters/ai-fake";
import {
  createDatabase,
  EMBED_DIMENSIONS,
  profile,
  profileTopics,
  runMigrations,
  topics,
} from "@radard/db";
import { eq, sql } from "drizzle-orm";
import {
  addCustomTopic,
  describeTopic,
  embedPendingTopics,
  listLibrary,
  listProfileTopics,
  pickTopics,
  seedLibrary,
  setTopicActive,
  toggleLibraryTopic,
} from "../src/jobs/topics.ts";
import { TOPIC_RECIPE, topicQueryText } from "../src/topics/instruct.ts";
import { TOPIC_LIBRARY, TOPIC_SUCCESSORS } from "../src/topics/library.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const embedder = fakeEmbedding({ dimensions: EMBED_DIMENSIONS });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate profile, topics restart identity cascade`);
  await db.insert(profile).values({ promptContext: "AI engineer" });
  await seedLibrary(db);
});

afterAll(async () => {
  await db.$bun.close();
});

describe("thư viện chủ đề", () => {
  test("seed hai lần không sinh bản trùng", async () => {
    await seedLibrary(db);
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(topics);
    expect(n?.n).toBe(TOPIC_LIBRARY.length);
    const lib = await listLibrary(db);
    expect(lib.map((t) => t.key)).toEqual(TOPIC_LIBRARY.map((t) => t.key));
    expect(lib.every((t) => !t.chosen)).toBe(true);
  });

  test("sửa câu mô tả trong thư viện thì chủ đề nhận câu mới và phải embed lại", async () => {
    await pickTopics(db, ["agents"]);
    await embedPendingTopics(db, embedder);
    await db.update(topics).set({ embedText: "cũ" }).where(eq(topics.key, "agents"));
    // Code giữ câu thật; seed lại đưa câu thật trở về và xoá embedding cũ của đúng chủ đề đó.
    const r = await seedLibrary(db);
    expect(r.refreshed).toBe(1);
    const rows = await db.select().from(topics);
    const agents = rows.find((t) => t.key === "agents");
    expect(agents?.embedText).toBe(TOPIC_LIBRARY.find((t) => t.key === "agents")?.embedText);
    expect(agents?.embedding).toBeNull();
    expect(rows.filter((t) => t.embedding !== null)).toHaveLength(TOPIC_LIBRARY.length - 1);
  });

  test("chủ đề embed kèm chỉ dẫn nhiệm vụ (Instruct/Query), ghi công thức; đổi công thức thì embed lại", async () => {
    await pickTopics(db, ["agents"]);
    const seen: string[] = [];
    const spy: typeof embedder = {
      ...embedder,
      embed: (t, k) => {
        seen.push(...t);
        return embedder.embed(t, k);
      },
    };
    expect(await embedPendingTopics(db, spy)).toBe(TOPIC_LIBRARY.length);
    const agents = TOPIC_LIBRARY.find((t) => t.key === "agents");
    expect(seen).toContain(topicQueryText(agents?.embedText ?? ""));
    expect(seen.every((t) => t.startsWith("Instruct: ") && t.includes("\nQuery: "))).toBe(true);
    const rows = await db.select().from(topics);
    expect(rows.every((t) => t.embeddingRecipe === TOPIC_RECIPE)).toBe(true);
    expect(await embedPendingTopics(db, embedder)).toBe(0);
    // Vector cũ từ trước khi có chỉ dẫn (recipe trống) phải được tính lại.
    await db.update(topics).set({ embeddingRecipe: null }).where(eq(topics.key, "agents"));
    expect(await embedPendingTopics(db, embedder)).toBe(1);
  });

  test("sửa phạm vi (labelGuide) thì chỉ cập nhật chữ, không phải embed lại", async () => {
    await embedPendingTopics(db, embedder);
    await db.update(topics).set({ labelGuide: "cũ" }).where(eq(topics.key, "agents"));
    const r = await seedLibrary(db);
    expect(r.refreshed).toBe(0);
    const rows = await db.select().from(topics);
    expect(rows.find((t) => t.key === "agents")?.labelGuide).toBe(
      TOPIC_LIBRARY.find((t) => t.key === "agents")?.labelGuide ?? "",
    );
    expect(rows.every((t) => t.embedding !== null && t.labelGuide)).toBe(true);
  });

  test("đổi tên llm_models (16/10/2026): nhãn mới, giữ khoá và embedding, không embed lại", async () => {
    await pickTopics(db, ["llm_models"]);
    await embedPendingTopics(db, embedder);
    // Dòng như trước khi đổi tên: nhãn và phạm vi cũ, câu mô tả không đổi.
    await db
      .update(topics)
      .set({ name: "LLM: model và hành vi", labelGuide: "cũ" })
      .where(eq(topics.key, "llm_models"));
    const [before] = await db.select().from(topics).where(eq(topics.key, "llm_models"));
    const r = await seedLibrary(db);
    expect(r.refreshed).toBe(0);
    const [after] = await db.select().from(topics).where(eq(topics.key, "llm_models"));
    expect(after?.id).toBe(before?.id ?? -1);
    expect(after?.name).toBe("Model AI: phát hành và hành vi");
    expect(after?.labelGuide).toContain("vision-language models (VLMs)");
    expect(after?.embedding).toEqual(before?.embedding ?? []);
    expect(after?.embeddingModel).toBe(embedder.model);
    // Lựa chọn của bạn vẫn trỏ đúng chủ đề đó.
    const mine = await listProfileTopics(db);
    expect(mine.map((t) => t.label)).toContain("Model AI: phát hành và hành vi");
    // Phạm vi của "Ảnh, video và âm thanh" trỏ sang nhãn mới.
    const media = TOPIC_LIBRARY.find((t) => t.key === "multimodal");
    expect(media?.labelGuide).toContain("→ Model AI: phát hành và hành vi");
  });

  test("bảng chuyển lựa chọn: chủ đề cũ đã rút khỏi thư viện, chủ đề mới có trong thư viện", () => {
    const keys = TOPIC_LIBRARY.map((t) => t.key);
    expect(new Set(keys).size).toBe(14);
    for (const [from, to] of Object.entries(TOPIC_SUCCESSORS)) {
      expect(keys).not.toContain(from);
      expect(keys).toContain(to);
    }
  });
});

describe("chuyển lựa chọn từ bộ 17 chủ đề cũ", () => {
  /** Bộ thư viện trước 15/10/2026, theo thứ tự cũ. */
  const OLD_KEYS = [
    "agents",
    "llm_apps",
    "rag_search",
    "ai_coding",
    "ai_products",
    "new_models",
    "open_models",
    "multimodal",
    "ml_research",
    "training",
    "ai_safety",
    "evals",
    "inference",
    "mlops",
    "open_source_tools",
    "ai_industry",
    "ai_policy",
  ];

  /** Lựa chọn của hồ sơ 1: [khoá, đang bật] cho mọi dòng `profile_topics`. */
  async function selections(): Promise<[string, boolean][]> {
    const rows = await db
      .select({ key: topics.key, active: profileTopics.active })
      .from(profileTopics)
      .innerJoin(topics, eq(topics.id, profileTopics.topicId))
      .where(eq(profileTopics.profileId, 1));
    return rows.map((r): [string, boolean] => [r.key ?? "", r.active]).sort();
  }

  test("lựa chọn của bạn (15/10/2026) thành đúng 8 chủ đề mới; chạy lại không đổi gì", async () => {
    await db.execute(sql`truncate profile, topics restart identity cascade`);
    await db.insert(profile).values({ promptContext: "AI engineer" });
    const old = await db
      .insert(topics)
      .values(
        OLD_KEYS.map((key, position) => ({
          key,
          groupName: "cũ",
          name: `cũ ${key}`,
          embedText: key,
          position,
        })),
      )
      .returning({ id: topics.id, key: topics.key });
    const id = (key: string) => old.find((t) => t.key === key)?.id ?? 0;
    // Đúng trạng thái DB trên máy: 9 chủ đề bật, `evals` và `mlops` đã chọn rồi tắt.
    const on = [
      "agents",
      "llm_apps",
      "rag_search",
      "ai_products",
      "new_models",
      "multimodal",
      "ml_research",
      "training",
      "open_source_tools",
    ];
    await db
      .insert(profileTopics)
      .values([
        ...on.map((k) => ({ topicId: id(k) })),
        { topicId: id("evals"), active: false },
        { topicId: id("mlops"), active: false },
      ]);

    const first = await seedLibrary(db);
    // Tắt 4 lựa chọn cũ: rag_search, new_models, ml_research, open_source_tools.
    expect(first.carried).toBe(4);
    const after = await selections();
    const active = after.filter(([, a]) => a).map(([k]) => k);
    expect(active.sort()).toEqual(
      [
        "agents",
        "llm_apps",
        "ai_products",
        "llm_models",
        "multimodal",
        "ml_foundations",
        "training",
        "ai_coding",
      ].sort(),
    );
    expect((await listLibrary(db)).filter((t) => t.chosen).map((t) => t.key)).toEqual([
      "llm_models",
      "training",
      "agents",
      "ai_coding",
      "llm_apps",
      "multimodal",
      "ai_products",
      "ml_foundations",
    ]);
    // Chủ đề cũ đã rút vẫn giữ dòng (không mất lịch sử), nhưng tắt.
    for (const k of ["rag_search", "new_models", "ml_research", "open_source_tools", "evals"]) {
      expect(after).toContainEqual([k, false]);
    }

    const second = await seedLibrary(db);
    expect(second.carried).toBe(0);
    expect(await selections()).toEqual(after);
  });

  test("lựa chọn đang tắt không được chuyển; chủ đề mới đang tắt được bật lại", async () => {
    await db.execute(sql`truncate profile, topics restart identity cascade`);
    await db.insert(profile).values({ promptContext: "AI engineer" });
    const [inference, evals] = await db
      .insert(topics)
      .values(
        ["inference", "evals"].map((key) => ({
          key,
          groupName: "cũ",
          name: key,
          embedText: key,
        })),
      )
      .returning({ id: topics.id });
    await seedLibrary(db);
    const [infra] = await db.select().from(topics).where(eq(topics.key, "ai_infra"));
    await db
      .insert(profileTopics)
      .values([
        { topicId: inference?.id ?? 0 },
        { topicId: evals?.id ?? 0, active: false },
        { topicId: infra?.id ?? 0, active: false },
      ]);
    await seedLibrary(db);
    expect(await selections()).toEqual([
      ["ai_infra", true],
      ["evals", false],
      ["inference", false],
    ]);
  });
});

describe("chọn và bật tắt", () => {
  test("chọn lại chủ đề đã tắt thì bật dòng cũ, không thêm dòng", async () => {
    expect(await pickTopics(db, ["agents", "llm_apps"])).toBe(2);
    const [first] = await listProfileTopics(db);
    await setTopicActive(db, first?.id ?? 0, false);
    await pickTopics(db, ["agents"]);
    const mine = await listProfileTopics(db);
    expect(mine).toHaveLength(2);
    expect(mine.every((t) => t.active)).toBe(true);
  });

  test("key lạ bị từ chối, không chọn gì", async () => {
    await expect(pickTopics(db, ["agents", "khong_co"])).rejects.toThrow("khong_co");
    expect(await listProfileTopics(db)).toHaveLength(0);
  });

  test("bấm nút thư viện hai lần: bật rồi tắt", async () => {
    const [lib] = await listLibrary(db);
    expect(await toggleLibraryTopic(db, lib?.id ?? 0)).toBe(true);
    expect((await listLibrary(db))[0]?.chosen).toBe(true);
    expect(await toggleLibraryTopic(db, lib?.id ?? 0)).toBe(false);
    expect((await listLibrary(db))[0]?.chosen).toBe(false);
  });
});

describe("tự thêm chủ đề", () => {
  test("LLM viết câu tiếng Anh; lưu cả lời gốc lẫn câu tiếng Anh", async () => {
    const llm = fakeLlm({
      reply: (prompt) => {
        expect(prompt).toContain("Postgres cho AI");
        return '"Postgres for AI: pgvector, vector indexes, HNSW, hybrid search in Postgres"\n';
      },
    });
    const en = await describeTopic(llm, "Postgres cho AI", "pgvector, index vector, tìm kiếm");
    expect(en).toBe("Postgres for AI: pgvector, vector indexes, HNSW, hybrid search in Postgres");
    const id = await addCustomTopic(db, {
      label: "Postgres cho AI",
      description: "pgvector, index vector, tìm kiếm",
      embedText: en,
    });
    const [row] = await db
      .select({ kind: profileTopics.kind, active: profileTopics.active, topic: topics })
      .from(profileTopics)
      .innerJoin(topics, eq(topics.id, profileTopics.topicId))
      .where(eq(profileTopics.id, id));
    // Chủ đề tự thêm là một dòng `topics` của hồ sơ, được chọn và bật ngay.
    expect(row?.topic.origin).toBe("custom");
    expect(row?.topic.ownerProfileId).toBe(1);
    expect(row?.topic.key).toBeNull();
    expect(row?.topic.description).toBe("pgvector, index vector, tìm kiếm");
    expect(row?.kind).toBe("include");
    expect(row?.active).toBe(true);
  });

  test("model trả rỗng thì báo lỗi, không lưu", async () => {
    await expect(describeTopic(fakeLlm({ reply: () => "  \n" }), "x", "y")).rejects.toThrow();
  });

  test("trùng tên (không phân biệt hoa thường) bị chặn", async () => {
    await pickTopics(db, ["agents"]);
    const label = TOPIC_LIBRARY.find((t) => t.key === "agents")?.name.toUpperCase() ?? "";
    await expect(addCustomTopic(db, { label, description: "a", embedText: "b" })).rejects.toThrow(
      "đã có",
    );
  });

  test("DB chặn chủ đề tự thêm thiếu lời của người dùng", async () => {
    // Query của Drizzle chỉ là "thenable", bọc trong async để expect bắt được lỗi.
    const insert = async () => {
      await db
        .insert(topics)
        .values({ name: "x", embedText: "y", origin: "custom", ownerProfileId: 1 });
    };
    await expect(insert()).rejects.toThrow();
  });
});

describe("embed chủ đề", () => {
  test("embed mọi chủ đề thư viện, bật hay chưa bật, trong một request; lần hai không gọi model", async () => {
    await pickTopics(db, ["agents", "llm_apps", "training"]);
    const mine = await listProfileTopics(db);
    await setTopicActive(db, mine[2]?.id ?? 0, false);
    let calls = 0;
    const counting = fakeEmbedding({
      dimensions: EMBED_DIMENSIONS,
      sink: async () => {
        calls++;
      },
    });
    expect(await embedPendingTopics(db, counting)).toBe(TOPIC_LIBRARY.length);
    expect(await embedPendingTopics(db, counting)).toBe(0);
    expect(calls).toBe(1);
  });
});
