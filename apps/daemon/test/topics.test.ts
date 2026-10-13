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
import { TOPIC_LIBRARY } from "../src/topics/library.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const embedder = fakeEmbedding({ dimensions: EMBED_DIMENSIONS });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate profile, topics restart identity cascade`);
  await db.insert(profile).values({ description: "AI engineer" });
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
    await db.update(topics).set({ descriptionEn: "cũ" }).where(eq(topics.key, "agents"));
    // Code giữ câu thật; seed lại đưa câu thật trở về và xoá embedding cũ của đúng chủ đề đó.
    const r = await seedLibrary(db);
    expect(r.refreshed).toBe(1);
    const rows = await db.select().from(topics);
    const agents = rows.find((t) => t.key === "agents");
    expect(agents?.descriptionEn).toBe(
      TOPIC_LIBRARY.find((t) => t.key === "agents")?.descriptionEn,
    );
    expect(agents?.embedding).toBeNull();
    expect(rows.filter((t) => t.embedding !== null)).toHaveLength(TOPIC_LIBRARY.length - 1);
  });
});

describe("chọn và bật tắt", () => {
  test("chọn lại chủ đề đã tắt thì bật dòng cũ, không thêm dòng", async () => {
    expect(await pickTopics(db, ["agents", "rag_search"])).toBe(2);
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
      descriptionUser: "pgvector, index vector, tìm kiếm",
      descriptionEn: en,
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
    expect(row?.topic.descriptionUser).toBe("pgvector, index vector, tìm kiếm");
    expect(row?.kind).toBe("include");
    expect(row?.active).toBe(true);
  });

  test("model trả rỗng thì báo lỗi, không lưu", async () => {
    await expect(describeTopic(fakeLlm({ reply: () => "  \n" }), "x", "y")).rejects.toThrow();
  });

  test("trùng tên (không phân biệt hoa thường) bị chặn", async () => {
    await pickTopics(db, ["agents"]);
    const label = TOPIC_LIBRARY.find((t) => t.key === "agents")?.labelVi.toUpperCase() ?? "";
    await expect(
      addCustomTopic(db, { label, descriptionUser: "a", descriptionEn: "b" }),
    ).rejects.toThrow("đã có");
  });

  test("DB chặn chủ đề tự thêm thiếu lời của người dùng", async () => {
    // Query của Drizzle chỉ là "thenable", bọc trong async để expect bắt được lỗi.
    const insert = async () => {
      await db
        .insert(topics)
        .values({ labelVi: "x", descriptionEn: "y", origin: "custom", ownerProfileId: 1 });
    };
    await expect(insert()).rejects.toThrow();
  });
});

describe("embed chủ đề", () => {
  test("embed mọi chủ đề thư viện, bật hay chưa bật, trong một request; lần hai không gọi model", async () => {
    await pickTopics(db, ["agents", "rag_search", "evals"]);
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
