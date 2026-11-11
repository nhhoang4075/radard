/**
 * "Với tôi?" (explainForProfile, POST /api/events/:id/for-me): phân quyền fail-closed theo hồ sơ,
 * cache, hạn mức mỗi ngày, chống đua, và route web. Tin của hồ sơ dựng thẳng vào feed_items.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeLlm } from "@radard/adapters/ai-fake";
import { createTelegramRouter } from "@radard/adapters/telegram";
import { FOR_ME_COPY } from "@radard/core";
import {
  createDatabase,
  deliveries,
  digests,
  documents,
  eventForProfile,
  eventSummaries,
  feedback,
  feedItems,
  feedSnapshots,
  invites,
  profile,
  profileChannels,
  profileTopics,
  runMigrations,
  sources,
} from "@radard/db";
import { testUtils } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { contextHashOf, explainForProfile, forMeSystem, vnDayStart } from "../src/jobs/for-me.ts";
import { chatResolver, forMeFor } from "../src/roles/bot.ts";
import { createWebApp } from "../src/web/app.ts";
import { createAuth } from "../src/web/auth.ts";
import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 4 });
const OWNER = "chu.du.an@example.com";
const SLOT = new Date("2026-10-06T00:00:00Z");
let seq = 0;
let sourceId = 0;

function replier(delayMs = 0) {
  const calls: { prompt: string; system?: string }[] = [];
  const llm = fakeLlm({
    async reply(prompt, system) {
      calls.push({ prompt, system });
      if (delayMs) await Bun.sleep(delayMs);
      return `  Suy luận của tôi: tin này liên quan tới bạn (${calls.length}).  `;
    },
  });
  return { llm, calls };
}

/** Một tin trong bản chụp của hồ sơ: tài liệu thật, feed_items thật (snapshot `ready`). */
async function addFeedItem(
  profileId: number,
  opts: { eventId?: number; title?: string; summary?: string } = {},
): Promise<{ eventId: number; feedItemId: number; docId: number }> {
  const id = ++seq;
  const eventId = opts.eventId ?? 5000 + id;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId,
      externalId: `e${id}`,
      url: `https://www.site${id}.com/post`,
      urlCanonical: `https://site${id}.com/post`,
      title: `Original title ${id}`,
      publishedAt: SLOT,
      contentSha256: `s${id}`,
      rawKey: `r/${id}`,
      contentType: "application/json",
    })
    .returning({ id: documents.id });
  await db
    .insert(feedSnapshots)
    .values({
      profileId,
      periodStart: new Date(SLOT.getTime() - 86_400_000),
      periodEnd: SLOT,
      status: "ready",
      selectSeed: 1,
      itemCount: 1,
    })
    .onConflictDoNothing();
  const [snap] = await db
    .select()
    .from(feedSnapshots)
    .where(eq(feedSnapshots.profileId, profileId));
  let summaryId: number | null = null;
  if (opts.summary) {
    const [s] = await db
      .insert(eventSummaries)
      .values({
        eventId,
        lang: "vi",
        docsHash: `h${id}`,
        title: "Tiêu đề chung",
        summary: opts.summary,
        model: "m",
      })
      .returning({ id: eventSummaries.id });
    summaryId = s?.id ?? null;
  }
  const [row] = await db
    .insert(feedItems)
    .values({
      profileId,
      snapshotId: snap?.id ?? 0,
      position: id,
      eventId,
      documentIds: [d?.id ?? 0],
      sourceId,
      topicId: null,
      title: opts.title ?? `Feed title ${id}`,
      score: 0.7,
      penalty: 0,
      r: 0.9,
      p: 0.5,
      c: 0.3,
      a: 0.3,
      f: 0.3,
      u: 0,
      n: 1,
      reserved: false,
      summaryId,
    })
    .returning({ id: feedItems.id });
  return { eventId, feedItemId: row?.id ?? 0, docId: d?.id ?? 0 };
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate "user", session, account, verification, invites, sources, documents, profile, topics, event_summaries restart identity cascade`,
  );
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  sourceId = s?.id ?? 0;
  await db.insert(profile).values({
    id: 1,
    promptContext: "I build AI agents.",
    description: "Mình làm agent",
    displayLang: "vi",
  });
  await db.insert(profile).values({ id: 2, promptContext: "I study robotics.", displayLang: "vi" });
  await addTopic(db, "Agent AI");
});

afterAll(async () => {
  await db.$bun.close();
});

describe("explainForProfile", () => {
  test("viết một lần rồi cache: lượt hai không gọi model; prompt có hồ sơ, tóm tắt chung và tài liệu", async () => {
    const { eventId } = await addFeedItem(1, { summary: "Tóm tắt chung của sự kiện này." });
    // Tin đã 👍 (mới nhất là like) vào prompt; tin 👎 thì không.
    const liked = await addFeedItem(1, { title: "Tin đã thích" });
    const disliked = await addFeedItem(1, { title: "Tin đã chê" });
    await db.insert(feedback).values([
      { profileId: 1, channel: "web", recipient: "w", kind: "like", feedItemId: liked.feedItemId },
      {
        profileId: 1,
        channel: "web",
        recipient: "w",
        kind: "dislike",
        feedItemId: disliked.feedItemId,
      },
    ]);
    const { llm, calls } = replier();
    const deps = { db, llm };

    const first = await explainForProfile(deps, { profileId: 1, eventId });
    expect(first).toEqual({
      status: "ok",
      text: "Suy luận của tôi: tin này liên quan tới bạn (1).",
      cached: false,
    });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("I build AI agents.");
    expect(prompt).toContain("Mình làm agent");
    expect(prompt).toContain("Agent AI");
    expect(prompt).toContain("Tóm tắt chung của sự kiện này.");
    expect(prompt).toContain("Original title 1");
    expect(prompt).toContain("- Tin đã thích");
    expect(prompt).not.toContain("Tin đã chê");
    // Yêu cầu của prompt hệ thống: 2-4 câu, chỉ dùng sự thật có sẵn, nói thẳng khi không liên quan, ghi rõ suy luận.
    const system = calls[0]?.system ?? "";
    expect(system).toContain("2-4 sentences");
    expect(system).toContain("Use only the facts in the input");
    expect(system).toContain("say so plainly in one sentence");
    expect(system).toContain("your inference");
    expect(system).toBe(forMeSystem("vi"));

    const second = await explainForProfile(deps, { profileId: 1, eventId });
    expect(second).toMatchObject({ status: "ok", cached: true });
    expect(calls).toHaveLength(1);
    expect(await db.select().from(eventForProfile)).toHaveLength(1);
  });

  test("FAIL-CLOSED: sự kiện của hồ sơ khác hoặc không có thì not_found và KHÔNG gọi model", async () => {
    const mine = await addFeedItem(1);
    const { llm, calls } = replier();
    const deps = { db, llm };
    // Hồ sơ 2 đòi sự kiện của hồ sơ 1.
    expect(await explainForProfile(deps, { profileId: 2, eventId: mine.eventId })).toEqual({
      status: "not_found",
    });
    expect(await explainForProfile(deps, { profileId: 1, eventId: 987654 })).toEqual({
      status: "not_found",
    });
    expect(await explainForProfile(deps, { profileId: 99, eventId: mine.eventId })).toEqual({
      status: "not_found",
    });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(eventForProfile)).toHaveLength(0);
    // Cache của hồ sơ 1 không lộ sang hồ sơ 2.
    await explainForProfile(deps, { profileId: 1, eventId: mine.eventId });
    expect(await explainForProfile(deps, { profileId: 2, eventId: mine.eventId })).toEqual({
      status: "not_found",
    });
    expect(calls).toHaveLength(1);
  });

  test("hai hồ sơ cùng sự kiện: mỗi hồ sơ một câu riêng theo hồ sơ của mình", async () => {
    const a = await addFeedItem(1);
    await addFeedItem(2, { eventId: a.eventId });
    const { llm, calls } = replier();
    await explainForProfile({ db, llm }, { profileId: 1, eventId: a.eventId });
    await explainForProfile({ db, llm }, { profileId: 2, eventId: a.eventId });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("I build AI agents.");
    expect(calls[1]?.prompt).toContain("I study robotics.");
    expect(calls[1]?.prompt).not.toContain("I build AI agents.");
  });

  test("hạn mức mỗi hồ sơ mỗi ngày: hết thì limit, không gọi model; cache hit không tính; sang ngày mới đếm lại", async () => {
    const items = [await addFeedItem(1), await addFeedItem(1), await addFeedItem(1)];
    const other = await addFeedItem(2);
    const { llm, calls } = replier();
    const now = new Date(); // created_at của dòng cache là giờ thật
    const deps = { db, llm, dailyLimit: 2, now: () => now };
    const ask = (i: number) =>
      explainForProfile(deps, { profileId: 1, eventId: items[i]?.eventId ?? 0 });

    expect((await ask(0)).status).toBe("ok");
    expect((await ask(0)).status).toBe("ok"); // cache hit, không tính
    expect((await ask(1)).status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(await ask(2)).toEqual({ status: "limit" });
    expect(calls).toHaveLength(2);
    // Cache hit vẫn trả lời dù đã hết hạn mức.
    expect(await ask(0)).toMatchObject({ status: "ok", cached: true });
    // Hạn mức theo hồ sơ: hồ sơ 2 không bị ảnh hưởng.
    expect((await explainForProfile(deps, { profileId: 2, eventId: other.eventId })).status).toBe(
      "ok",
    );
    // Sang ngày mới (giờ VN): đếm lại.
    const tomorrow = { ...deps, now: () => new Date(now.getTime() + 25 * 3_600_000) };
    expect(
      (await explainForProfile(tomorrow, { profileId: 1, eventId: items[2]?.eventId ?? 0 })).status,
    ).toBe("ok");
    expect(vnDayStart(new Date("2026-10-06T20:00:00Z"))).toEqual(new Date("2026-10-06T17:00:00Z"));
  });

  test("bấm dồn: các lượt cùng lúc chỉ tốn một lời gọi model", async () => {
    const { eventId } = await addFeedItem(1);
    const { llm, calls } = replier(80);
    const res = await Promise.all([
      explainForProfile({ db, llm }, { profileId: 1, eventId }),
      explainForProfile({ db, llm }, { profileId: 1, eventId }),
      explainForProfile({ db, llm }, { profileId: 1, eventId }),
    ]);
    expect(calls).toHaveLength(1);
    expect(res.every((r) => r.status === "ok")).toBe(true);
    expect(new Set(res.map((r) => (r.status === "ok" ? r.text : ""))).size).toBe(1);
    expect(await db.select().from(eventForProfile)).toHaveLength(1);
  });

  test("bấm dồn nhiều tin không vượt hạn mức", async () => {
    const items = await Promise.all([addFeedItem(1), addFeedItem(1), addFeedItem(1)]);
    const { llm, calls } = replier(60);
    const res = await Promise.all(
      items.map((it) =>
        explainForProfile({ db, llm, dailyLimit: 2 }, { profileId: 1, eventId: it.eventId }),
      ),
    );
    expect(res.filter((r) => r.status === "ok")).toHaveLength(2);
    expect(res.filter((r) => r.status === "limit")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("cache theo bối cảnh hồ sơ: đổi mô tả hoặc chủ đề đang bật thì viết lại; tin mới thích thì không", async () => {
    const { eventId } = await addFeedItem(1);
    const { llm, calls } = replier();
    const deps = { db, llm };
    await explainForProfile(deps, { profileId: 1, eventId });
    // Thích thêm một tin: context_hash không gồm tin đã thích.
    const liked = await addFeedItem(1);
    await db.insert(feedback).values({
      profileId: 1,
      channel: "web",
      recipient: "w",
      kind: "like",
      feedItemId: liked.feedItemId,
    });
    expect(await explainForProfile(deps, { profileId: 1, eventId })).toMatchObject({
      cached: true,
    });
    expect(calls).toHaveLength(1);

    await db
      .update(profile)
      .set({ promptContext: "I build AI agents and RAG." })
      .where(eq(profile.id, 1));
    expect(await explainForProfile(deps, { profileId: 1, eventId })).toMatchObject({
      cached: false,
    });
    expect(calls).toHaveLength(2);
    await db.update(profileTopics).set({ active: false }).where(eq(profileTopics.profileId, 1));
    expect(await explainForProfile(deps, { profileId: 1, eventId })).toMatchObject({
      cached: false,
    });
    expect(calls).toHaveLength(3);
    expect(await db.select().from(eventForProfile)).toHaveLength(3);
    expect(contextHashOf({ description: null, promptContext: "a", topicIds: [2, 1] })).toBe(
      contextHashOf({ description: null, promptContext: "a", topicIds: [1, 2] }),
    );
  });

  test("model lỗi hoặc chưa cấu hình: unavailable, không ghi cache; cache có sẵn vẫn trả được", async () => {
    const { eventId } = await addFeedItem(1);
    expect(await explainForProfile({ db, llm: null }, { profileId: 1, eventId })).toEqual({
      status: "unavailable",
    });
    const broken = fakeLlm({
      reply() {
        throw new Error("hết giờ");
      },
    });
    expect(await explainForProfile({ db, llm: broken }, { profileId: 1, eventId })).toEqual({
      status: "unavailable",
    });
    expect(await db.select().from(eventForProfile)).toHaveLength(0);
    const { llm } = replier();
    await explainForProfile({ db, llm }, { profileId: 1, eventId });
    expect(await explainForProfile({ db, llm: null }, { profileId: 1, eventId })).toMatchObject({
      status: "ok",
      cached: true,
    });
  });
});

describe("Telegram: forMeFor (nút Với tôi?)", () => {
  async function delivered(
    profileId: number,
    eventId: number,
    recipient: string,
    messageId: string,
  ) {
    const [dg] = await db
      .insert(digests)
      .values({
        profileId,
        channel: "telegram",
        recipient,
        periodStart: new Date(SLOT.getTime() - 86_400_000),
        periodEnd: SLOT,
        lang: "vi",
      })
      .returning({ id: digests.id });
    await db.insert(deliveries).values({
      profileId,
      digestId: dg?.id ?? 0,
      channel: "telegram",
      recipient,
      messageId,
      kind: "event",
      position: 1,
      eventId,
      documentIds: [],
      title: "1. x",
      body: "x",
    });
  }
  const base = { db, embedder: null, decider: null };

  test("tin của chính hồ sơ: trả lời; bấm hai lần thì cache; tin lạ hoặc của hồ sơ khác: not_found, không gọi model", async () => {
    const mine = await addFeedItem(1);
    await delivered(1, mine.eventId, "100", "58");
    const { llm, calls } = replier();
    const deps = { ...base, llm, profileId: 1 };
    const ev = { channel: "telegram", recipient: "100", messageId: "58" };
    expect(await forMeFor(deps, ev)).toMatchObject({ status: "ok" });
    expect(await forMeFor(deps, ev)).toMatchObject({ status: "ok" });
    expect(calls).toHaveLength(1);
    // Message id không có / của người nhận khác.
    expect(await forMeFor(deps, { ...ev, messageId: "999" })).toEqual({ status: "not_found" });
    expect(await forMeFor(deps, { ...ev, recipient: "200" })).toEqual({ status: "not_found" });
    // Hồ sơ 2 bấm vào tin của hồ sơ 1 (cùng chat/message id): không tra được qua profile_id.
    expect(await forMeFor({ ...deps, profileId: 2 }, ev)).toEqual({ status: "not_found" });
    expect(calls).toHaveLength(1);
  });

  test("tin còn nhưng sự kiện không còn trong feed của hồ sơ: not_found (kiểm lại ở explainForProfile)", async () => {
    await delivered(1, 424242, "100", "58");
    const { llm, calls } = replier();
    expect(
      await forMeFor(
        { ...base, llm, profileId: 1 },
        { channel: "telegram", recipient: "100", messageId: "58" },
      ),
    ).toEqual({ status: "not_found" });
    expect(calls).toHaveLength(0);
  });

  test("hai lượt bấm đồng thời chỉ gọi model một lần", async () => {
    const mine = await addFeedItem(1);
    await delivered(1, mine.eventId, "100", "58");
    const { llm, calls } = replier(80);
    const deps = { ...base, llm, profileId: 1 };
    const ev = { channel: "telegram", recipient: "100", messageId: "58" };
    const res = await Promise.all([forMeFor(deps, ev), forMeFor(deps, ev)]);
    expect(res.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(calls).toHaveLength(1);
  });
});

// Daemon không import grammY (chỉ packages/adapters được): lấy kiểu từ chính adapter.
type RouterOpts = Parameters<typeof createTelegramRouter>[0];
type Transformer = NonNullable<RouterOpts["transformer"]>;
type UserFromGetMe = NonNullable<RouterOpts["botInfo"]>;
type Update = Parameters<ReturnType<typeof createTelegramRouter>["handleUpdate"]>[0];

describe("Telegram thật: router + chatResolver + nút fm:ask", () => {
  const botInfo = {
    id: 42,
    is_bot: true,
    first_name: "radard",
    username: "radard_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as UserFromGetMe;
  const press = (chatId: string, cbId: string): Update =>
    ({
      update_id: 1,
      callback_query: {
        id: cbId,
        from: { id: Number(chatId), is_bot: false, first_name: "H" },
        chat_instance: "x",
        data: "fm:ask",
        message: {
          message_id: 58,
          date: 0,
          chat: { id: Number(chatId), type: "private", first_name: "H" },
          text: "tin",
        },
      },
    }) as Update;

  async function setup(llm: ReturnType<typeof replier>["llm"] | null) {
    const sent: { method: string; payload: Record<string, unknown> }[] = [];
    const t: Transformer = async (_prev, method, payload) => {
      sent.push({ method, payload: payload as Record<string, unknown> });
      return {
        ok: true,
        result: method === "sendMessage" ? { message_id: 59, date: 0, chat: { id: 1 } } : true,
      } as never;
    };
    const mine = await addFeedItem(1);
    await db
      .insert(profileChannels)
      .values({ profileId: 1, channel: "telegram", recipient: "100" });
    const [dg] = await db
      .insert(digests)
      .values({
        profileId: 1,
        channel: "telegram",
        recipient: "100",
        periodStart: new Date(SLOT.getTime() - 86_400_000),
        periodEnd: SLOT,
        lang: "vi",
      })
      .returning({ id: digests.id });
    await db.insert(deliveries).values({
      profileId: 1,
      digestId: dg?.id ?? 0,
      channel: "telegram",
      recipient: "100",
      messageId: "58",
      kind: "event",
      position: 1,
      eventId: mine.eventId,
      documentIds: [],
      title: "1. x",
      body: "x",
    });
    const bot = createTelegramRouter(
      { token: "123:TEST", botInfo, transformer: t },
      chatResolver({ db, embedder: null, llm, decider: null }, "telegram", () => {}),
    );
    return { bot, sent };
  }

  test("chat chưa nối hồ sơ bấm: bị bỏ qua, không gọi model, không gọi API Telegram nào", async () => {
    const { llm, calls } = replier();
    const { bot, sent } = await setup(llm);
    await bot.handleUpdate(press("999", "cb-x"));
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(eventForProfile)).toHaveLength(0);
  });

  test("chat đã nối bấm hai lần cùng lúc: model chỉ được gọi một lần, cả hai nhận câu trả lời", async () => {
    const { llm, calls } = replier(80);
    const { bot, sent } = await setup(llm);
    await Promise.all([
      bot.handleUpdate(press("100", "cb-1")),
      bot.handleUpdate(press("100", "cb-2")),
    ]);
    expect(calls).toHaveLength(1);
    const replies = sent.filter((c) => c.method === "sendMessage");
    expect(replies).toHaveLength(2);
    expect(replies.every((r) => String(r.payload.text).startsWith("Suy luận của tôi"))).toBe(true);
    expect(sent.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(2);
  });

  test("chưa cấu hình model: báo lỗi trong chat, không ghi cache", async () => {
    const { bot, sent } = await setup(null);
    await bot.handleUpdate(press("100", "cb-1"));
    const reply = sent.find((c) => c.method === "sendMessage");
    expect(reply?.payload.text).toBe(FOR_ME_COPY.unavailable);
    expect(await db.select().from(eventForProfile)).toHaveLength(0);
  });
});

describe("POST /api/events/:id/for-me", () => {
  const auth = createAuth({
    db,
    config: {
      secret: "khoa-thu-nghiem-0123456789-0123456789",
      baseURL: "http://localhost:8080",
      bootstrapOwnerEmails: [OWNER],
      providers: {},
    },
    plugins: [testUtils()],
  });
  const mkApp = (llm: ReturnType<typeof replier>["llm"] | null, forMeDailyLimit?: number) =>
    createWebApp({
      db,
      secret: undefined,
      auth: { auth, providers: [] },
      llm,
      ...(forMeDailyLimit === undefined ? {} : { forMeDailyLimit }),
    }).app;
  async function login(email: string) {
    const ctx = await auth.$context;
    const { user } = await ctx.internalAdapter.createOAuthUser(
      { email, name: email, emailVerified: true },
      { providerId: "github", accountId: `gh-${email}` },
    );
    const t = (await auth.$context) as unknown as {
      test: { login(o: { userId: string }): Promise<{ headers: Headers }> };
    };
    return (await t.test.login({ userId: user.id })).headers;
  }
  const post = (app: ReturnType<typeof mkApp>, id: number | string, headers?: Headers) =>
    app.request(`/api/events/${id}/for-me`, { method: "POST", ...(headers ? { headers } : {}) });

  test("200 { text, cached }; lượt hai cached; 404 sự kiện của hồ sơ khác; 401 khi chưa đăng nhập", async () => {
    await db.insert(invites).values({ email: "khach@example.com" });
    const ownerHeaders = await login(OWNER); // nối hồ sơ 1
    const guestHeaders = await login("khach@example.com"); // hồ sơ 3 (1 và 2 đã có)
    const mine = await addFeedItem(1);
    const theirs = await addFeedItem(2);
    const { llm, calls } = replier();
    const app = mkApp(llm);

    expect((await post(app, mine.eventId)).status).toBe(401);
    const res = await post(app, mine.eventId, ownerHeaders);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "Suy luận của tôi: tin này liên quan tới bạn (1).",
      cached: false,
    });
    expect(await (await post(app, mine.eventId, ownerHeaders)).json()).toMatchObject({
      cached: true,
    });
    expect(calls).toHaveLength(1);

    // Khách đòi sự kiện của hồ sơ 1 hoặc 2: 404, không gọi model, không ghi cache.
    for (const id of [mine.eventId, theirs.eventId, 424242, "abc", "1e3"]) {
      expect((await post(app, id, guestHeaders)).status).toBe(404);
    }
    expect(calls).toHaveLength(1);
    expect(await db.select().from(eventForProfile)).toHaveLength(1);
  });

  test("429 khi hết hạn mức, 503 khi chưa cấu hình model", async () => {
    const ownerHeaders = await login(OWNER);
    const a = await addFeedItem(1);
    const b = await addFeedItem(1);
    const { llm, calls } = replier();
    const limited = mkApp(llm, 1);
    expect((await post(limited, a.eventId, ownerHeaders)).status).toBe(200);
    const res = await post(limited, b.eventId, ownerHeaders);
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
    expect((await post(limited, a.eventId, ownerHeaders)).status).toBe(200); // cache hit

    expect((await post(mkApp(null), b.eventId, ownerHeaders)).status).toBe(503);
  });
});
