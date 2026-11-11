/**
 * Topics and context per profile: two profiles (id 1 and 2) do not interfere when toggling topics,
 * when editing context, and when listing their own topics.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, profile, runMigrations } from "@radard/db";
import { eq, sql } from "drizzle-orm";
import { readProfile, saveProfile } from "../src/jobs/profile.ts";
import {
  addCustomTopic,
  listLibrary,
  listProfileTopics,
  pickTopics,
  seedLibrary,
  setLibraryTopics,
  setTopicActive,
  toggleLibraryTopic,
} from "../src/jobs/topics.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  await db.execute(sql`truncate profile, topics restart identity cascade`);
  await db.insert(profile).values([
    { id: 1, promptContext: "context one", description: "one", displayLang: "vi" },
    { id: 2, promptContext: "context two", description: "two", displayLang: "en" },
  ]);
  await seedLibrary(db);
});

afterAll(async () => {
  await db.$bun.close();
});

const chosenKeys = async (profileId: number) =>
  (await listLibrary(db, profileId)).filter((t) => t.chosen).map((t) => t.key);

describe("chủ đề theo hồ sơ", () => {
  test("bật, tắt chủ đề của hồ sơ 2 không ảnh hưởng hồ sơ 1", async () => {
    await pickTopics(db, 1, ["agents"]);
    await pickTopics(db, 2, ["agents", "robotics"]);
    expect(await chosenKeys(1)).toEqual(["agents"]);
    expect((await chosenKeys(2)).sort()).toEqual(["agents", "robotics"]);

    const lib = await listLibrary(db, 2);
    const robotics = lib.find((t) => t.key === "robotics");
    expect(await toggleLibraryTopic(db, 2, robotics?.id ?? 0)).toBe(false);
    const agents = lib.find((t) => t.key === "agents");
    await setLibraryTopics(db, 2, [], [agents?.id ?? 0]);
    expect(await chosenKeys(2)).toEqual([]);
    expect(await chosenKeys(1)).toEqual(["agents"]);

    const mine = await listProfileTopics(db, 1);
    expect(mine.map((t) => t.active)).toEqual([true]);
    // Profile 2 cannot toggle profile 1's profile_topics row.
    expect(await setTopicActive(db, 2, mine[0]?.id ?? 0, false)).toBe(false);
    expect(await chosenKeys(1)).toEqual(["agents"]);
  });

  test("chủ đề tự thêm của hồ sơ nào chỉ hiện ở hồ sơ đó, cùng tên vẫn thêm được cho hồ sơ kia", async () => {
    const draft = { label: "Chủ đề riêng", description: "d", embedText: "private topic text" };
    await addCustomTopic(db, 2, draft);
    expect((await listProfileTopics(db, 2)).map((t) => t.label)).toEqual(["Chủ đề riêng"]);
    expect(await listProfileTopics(db, 1)).toEqual([]);
    await addCustomTopic(db, 1, draft);
    expect((await listProfileTopics(db, 1)).map((t) => t.label)).toEqual(["Chủ đề riêng"]);
    await expect(addCustomTopic(db, 2, draft)).rejects.toThrow("đã có chủ đề");
  });
});

describe("bối cảnh theo hồ sơ", () => {
  test("saveProfile và readProfile cho hồ sơ 2 không sửa hồ sơ 1", async () => {
    await saveProfile(db, 2, "mô tả mới", "new english context");
    expect(await readProfile(db, 2)).toEqual({
      description: "mô tả mới",
      promptContext: "new english context",
    });
    expect(await readProfile(db, 1)).toEqual({ description: "one", promptContext: "context one" });
    const [p1] = await db.select().from(profile).where(eq(profile.id, 1));
    expect(p1?.displayLang).toBe("vi");
  });
});
