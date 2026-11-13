/**
 * Item scoring job on `radard_test` with a fake Notifier and fake LLM: rerunning does not send duplicates, a crash in the middle
 * resumes by sending the missing part, a broken LLM sends the version without summaries, quiet days still have items.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeDecision, fakeLlm } from "@radard/adapters/ai-fake";
import { fakeNotifier } from "@radard/adapters/notify-fake";
import { deriveSimSeed } from "@radard/core";
import {
  baselines,
  createDatabase,
  deliveries,
  digests,
  docText,
  docTopicScores,
  documents,
  eventDocuments,
  eventSummaries,
  events,
  feedSnapshots,
  profile,
  profileTopics,
  runMigrations,
  sources,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import {
  buildLinks,
  buildPlan,
  type DigestPlan,
  digestSlot,
  type ItemDoc,
  runDigest,
  vnDate,
} from "../src/jobs/digest.ts";
import { ensureFeedSnapshot } from "../src/jobs/feed.ts";
import type { SelectionLearning } from "../src/jobs/selection-learning.ts";
import { generateIntro, parseIntro } from "../src/jobs/snapshot-intro.ts";
import { parseSummaryBatch } from "../src/jobs/summaries.ts";

import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const RECIPIENT = "100000001";
/** 07:00 Vietnam time on 06/10. */
const SLOT = new Date("2026-10-06T00:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
let hn = 0;
let topic = 0;
let seq = 0;

async function addEvent(score = 0.79, sourceId = hn): Promise<{ eventId: number; docId: number }> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId,
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
  const v = new Array(1024).fill(0);
  v[id % 1024] = 1;
  const [e] = await db
    .insert(events)
    .values({
      title: `seed ${id}`,
      firstSeenAt: IN,
      lastSeenAt: IN,
      centroid: v,
      embeddingModel: "m",
    })
    .returning({ id: events.id });
  await db
    .insert(eventDocuments)
    .values({ eventId: e?.id ?? 0, documentId: d?.id ?? 0, similarity: 1, reason: "seed" });
  await db.insert(docTopicScores).values({ documentId: d?.id ?? 0, topicId: topic, score });
  return { eventId: e?.id ?? 0, docId: d?.id ?? 0 };
}

/**
 * Fake LLM. Two kinds of calls: shared summaries (system "news summaries": one summary per `Story n`) and the
 * snapshot's opening paragraph (system "opening line of one reader's morning news brief": `Story n: title` lines).
 */
function goodLlm() {
  const calls: { prompt: string; system?: string }[] = [];
  const summaryCalls: { prompt: string; system?: string }[] = [];
  const introCalls: { prompt: string; system?: string }[] = [];
  const llm = fakeLlm({
    reply(prompt, system) {
      calls.push({ prompt, system });
      const wrap = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
      if (system?.includes("opening line")) {
        introCalls.push({ prompt, system });
        return wrap({ intro: "Sáng nay nổi bật là agent." });
      }
      summaryCalls.push({ prompt, system });
      const n = (prompt.match(/^Story \d+$/gm) ?? []).length;
      const items = Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        title: `Tiêu đề ${i + 1}`,
        summary: `Tóm tắt tin số ${i + 1}, đủ dài để qua kiểm tra.`,
      }));
      return wrap({ items });
    },
  });
  return { llm, calls, summaryCalls, introCalls };
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests, event_summaries restart identity cascade`,
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

const planOf = (meta: unknown): DigestPlan => {
  const plan = (meta as { plan?: DigestPlan } | undefined)?.plan;
  if (!plan) throw new Error("chưa có plan");
  return plan;
};

const positions = async () =>
  (await db.select().from(deliveries).orderBy(asc(deliveries.position))).map((d) => d.position);

describe("hồ sơ thứ hai", () => {
  test("bản chụp và runDigest của hồ sơ 2 dùng ngôn ngữ và bối cảnh của hồ sơ 2, không lấy của hồ sơ 1", async () => {
    await db
      .insert(profile)
      .values({ id: 2, promptContext: "I study robotics.", displayLang: "en" });
    await db.insert(profileTopics).values({ profileId: 2, topicId: topic });
    for (let i = 0; i < 3; i++) await addEvent();
    const one = goodLlm();
    await ensureFeedSnapshot({ db, profileId: 1, llm: one.llm }, SLOT);
    const two = goodLlm();
    const { items } = await ensureFeedSnapshot({ db, profileId: 2, llm: two.llm }, SLOT);
    expect(items.length).toBeGreaterThan(0);
    // Opening paragraph per profile: context and language of that exact profile.
    expect(one.introCalls[0]?.system).toContain("I build AI agents.");
    expect(one.introCalls[0]?.system).toContain("Write in Vietnamese");
    expect(two.introCalls[0]?.system).toContain("I study robotics.");
    expect(two.introCalls[0]?.system).not.toContain("I build AI agents.");
    expect(two.introCalls[0]?.system).toContain("Write in English");
    // Shared summary is written in the language, carrying no reader's context.
    expect(one.summaryCalls[0]?.system).toContain("Write in Vietnamese");
    expect(two.summaryCalls[0]?.system).toContain("Write in English");
    expect(two.summaryCalls[0]?.system).not.toContain("I study robotics.");
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 2, llm: goodLlm().llm, notifier, recipient: RECIPIENT }, SLOT);
    const [row] = await db.select().from(digests).where(eq(digests.profileId, 2));
    expect(row?.lang).toBe("en");
  });
});

describe("runDigest", () => {
  test("digest và mọi tin gửi mang đúng profile_id của hồ sơ được truyền vào", async () => {
    await db.insert(profile).values({ id: 2, promptContext: "y" });
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 2, llm: null, notifier, recipient: RECIPIENT }, SLOT);
    const dgs = await db.select().from(digests);
    expect(dgs.map((d) => d.profileId)).toEqual([2]);
    const dls = await db.select().from(deliveries);
    expect(dls.length).toBeGreaterThan(0);
    expect(dls.every((d) => d.profileId === 2)).toBe(true);
  });

  test("gửi tin mở đầu rồi từng tin; chạy lại cùng khung thì không gửi gì thêm", async () => {
    for (let i = 0; i < 4; i++) await addEvent();
    const notifier = fakeNotifier();
    const { llm, calls, introCalls } = goodLlm();
    const deps = { db, profileId: 1, llm, notifier, recipient: RECIPIENT };

    const first = await runDigest(deps, SLOT);
    expect(first).toMatchObject({ status: "sent", sentNow: 5, items: 4, summarized: true });
    const [header, item] = notifier.sent.map((s) => s.msg);
    expect(header?.title).toBe("Điểm tin 06/10");
    expect(header?.lines[0]).toBe("Sáng nay nổi bật là agent.");
    expect(header?.lines[1]).toBe(
      "Chọn 4 trong 4 sự kiện thuộc các chủ đề bạn quan tâm trong 24 giờ qua.",
    );
    expect(item?.title).toBe("1. Tiêu đề 1");
    expect(item?.lines).toEqual([
      "Tóm tắt tin số 1, đủ dài để qua kiểm tra.",
      "Chủ đề: Agent AI · HN",
    ]);
    // Original article (domain, full link) and the HN discussion page declared by the adapter.
    // Item order comes from Gumbel selection (T > 0), so the first item can be any of the 4 items with close scores.
    const label = item?.links?.[0]?.label ?? "";
    expect(label).toMatch(/^site[1-4]\.com$/);
    expect(item?.links?.map((l) => l.role)).toEqual(["main", "discussion"]);
    expect(item?.links?.[1]?.label).toBe("HN");
    expect(item?.links?.[1]?.url).toBe(
      `https://news.ycombinator.com/item?id=${1000 + Number(label.slice(4, 5))}`,
    );
    expect(item?.actions?.map((a) => a.id)).toEqual(["like", "dislike", "for_me"]);
    // The intro call (made when the snapshot was built) reads context from the profile, not hard-coded.
    expect(introCalls[0]?.system).toContain("I build AI agents.");
    expect(introCalls[0]?.system).toContain("Vietnamese");

    expect(await positions()).toEqual([0, 1, 2, 3, 4]);
    const [dg] = await db.select().from(digests);
    expect(dg?.status).toBe("sent");
    const plan = planOf(dg?.meta);
    expect(plan.items.map((i) => i.score.S > 0)).toEqual([true, true, true, true]);
    expect(plan.ranking.config.priors).toEqual({ [hn]: 0.6 });

    const again = await runDigest(deps, SLOT);
    expect(again).toMatchObject({ status: "already_sent", sentNow: 0 });
    expect(notifier.sent).toHaveLength(5);
    // One shared-summary batch + one intro call, both at snapshot time; rerunning makes no further calls.
    expect(calls).toHaveLength(2);
  });

  test("chết sau tin thứ 3 thì lượt sau gửi tiếp từ tin còn thiếu, theo plan đã lưu", async () => {
    for (let i = 0; i < 4; i++) await addEvent();
    const notifier = fakeNotifier({ failAfter: 3 });
    const { llm, calls } = goodLlm();
    const deps = { db, profileId: 1, llm, notifier, recipient: RECIPIENT };

    await expect(runDigest(deps, SLOT)).rejects.toThrow("mạng rớt");
    const [failed] = await db.select().from(digests);
    expect(failed?.status).toBe("failed");
    expect(await positions()).toEqual([0, 1, 2]);

    // Meanwhile new events arrive: the saved plan is used, so no re-selection.
    await addEvent(0.8);
    notifier.failAfter = undefined;
    const out = await runDigest(deps, SLOT);
    expect(out).toMatchObject({ status: "sent", sentNow: 2, items: 4 });
    expect(notifier.sent.map((s) => s.msg.title)).toEqual([
      "Điểm tin 06/10",
      "1. Tiêu đề 1",
      "2. Tiêu đề 2",
      "3. Tiêu đề 3",
      "4. Tiêu đề 4",
    ]);
    expect(await positions()).toEqual([0, 1, 2, 3, 4]);
    expect(calls).toHaveLength(2);
  });

  test("LLM trả JSON hỏng hai lần thì gửi bản không tóm tắt: tiêu đề gốc và link", async () => {
    await addEvent();
    let calls = 0;
    const llm = fakeLlm({
      reply() {
        calls++;
        return '{"intro": "x", "items": [';
      },
    });
    const notifier = fakeNotifier();
    const out = await runDigest({ db, profileId: 1, llm, notifier, recipient: RECIPIENT }, SLOT);
    expect(out).toMatchObject({ status: "sent", summarized: false, items: 1 });
    // Each job (shared summary, snapshot intro) is tried exactly twice, both when the snapshot is built.
    expect(calls).toBe(4);
    const [header, item] = notifier.sent.map((s) => s.msg);
    expect(header?.lines[0]).toMatch(/^Chọn 1 trong 1 /);
    expect(header?.lines.join(" ")).toContain("Bản không tóm tắt");
    expect(item?.title).toBe("1. Original title 1");
    expect(item?.lines).toEqual(["Chủ đề: Agent AI · HN"]);
    const [snap] = await db.select().from(feedSnapshots);
    expect(snap?.status).toBe("ready");
    expect(snap?.meta.intro).toBeUndefined();
  });

  test("Telegram dùng đúng tóm tắt đã chụp trong bản chụp, không gọi model tóm tắt riêng", async () => {
    await addEvent();
    await addEvent();
    // Snapshot built without a model: item has no summary_id.
    await ensureFeedSnapshot({ db, profileId: 1, llm: null }, SLOT);
    const { llm, calls, summaryCalls } = goodLlm();
    const notifier = fakeNotifier();
    const out = await runDigest({ db, profileId: 1, llm, notifier, recipient: RECIPIENT }, SLOT);
    expect(out).toMatchObject({ status: "sent", summarized: false, items: 2 });
    expect(summaryCalls).toHaveLength(0);
    // The digest makes no model call of its own; the snapshot has no intro, so the header has no intro line.
    expect(calls).toHaveLength(0);
    expect(notifier.sent[0]?.msg.lines[0]).toMatch(/^Chọn 2 trong 2 /);
    expect(notifier.sent[1]?.msg.title).toMatch(/^1\. Original title \d$/);
    expect((await db.select().from(eventSummaries)).length).toBe(0);
  });

  test("ngày không có tin nào vượt sàn: một tin ngắn, không gọi LLM (D5)", async () => {
    await addEvent(0.5); // below gate R
    let calls = 0;
    const llm = fakeLlm({
      reply() {
        calls++;
        return "{}";
      },
    });
    const notifier = fakeNotifier();
    const out = await runDigest({ db, profileId: 1, llm, notifier, recipient: RECIPIENT }, SLOT);
    expect(out).toMatchObject({ status: "sent", sentNow: 1, items: 0 });
    expect(calls).toBe(0);
    expect(notifier.sent[0]?.msg.lines).toEqual([
      "Hôm nay không có tin tức đáng chú ý.",
      "Không có sự kiện nào thuộc các chủ đề bạn quan tâm trong 24 giờ qua.",
    ]);
  });

  test("ngày yên ắng có tin thuộc chủ đề nhưng dưới sàn: nói rõ số tin đó", async () => {
    await addEvent(0.66); // z = 0,65: passes gate R, S ≈ 0,5 below the floor 0,59
    await addEvent(0.66);
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 1, llm: null, notifier, recipient: RECIPIENT }, SLOT);
    expect(notifier.sent[0]?.msg.lines[1]).toBe(
      "Có 2 sự kiện thuộc các chủ đề bạn quan tâm nhưng chưa đủ mức đáng đọc.",
    );
  });

  test("Telegram lấy lời mở đầu và số sự kiện từ meta của bản chụp, không gọi model", async () => {
    await addEvent();
    await addEvent();
    await ensureFeedSnapshot({ db, profileId: 1, llm: null }, SLOT);
    // Values set by hand: expected output derives from them, not from the code.
    await db
      .update(feedSnapshots)
      .set({ meta: sql`meta || '{"intro":"Hôm nay nổi bật là X.","eventCount":1132}'::jsonb` });
    const { llm, calls } = goodLlm();
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 1, llm, notifier, recipient: RECIPIENT }, SLOT);
    expect(calls).toHaveLength(0);
    expect(notifier.sent[0]?.msg.lines.slice(0, 2)).toEqual([
      "Hôm nay nổi bật là X.",
      `Chọn 2 trong ${(1132).toLocaleString("vi-VN")} sự kiện thuộc các chủ đề bạn quan tâm trong 24 giờ qua.`,
    ]);
    // The topic label is the topic stored on the feed item.
    expect(notifier.sent[1]?.msg.lines.at(-1)).toBe("Chủ đề: Agent AI · HN");
  });

  test("bản chụp cũ không có meta.intro/eventCount: bỏ dòng mở đầu, số sự kiện lấy từ ranking", async () => {
    await addEvent();
    await ensureFeedSnapshot({ db, profileId: 1, llm: null }, SLOT);
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 1, llm: null, notifier, recipient: RECIPIENT }, SLOT);
    expect(notifier.sent[0]?.msg.lines[0]).toBe(
      "Chọn 1 trong 1 sự kiện thuộc các chủ đề bạn quan tâm trong 24 giờ qua.",
    );
  });

  test("plan ghi lại cổng vùng xám: từng sự kiện đã hỏi, xác suất, qua hay loại", async () => {
    await addEvent(); // R ≈ 0,98: passes without asking
    const yes = await addEvent(0.62); // R = 0,55
    const no = await addEvent(0.66); // R = 0,65
    for (const d of [yes, no]) {
      await db.insert(docText).values({
        documentId: d.docId,
        text: `Original title ${d.docId}. Body.`,
        lang: "eng",
        embedding: new Array(1024).fill(0.01),
        embeddingModel: "m",
      });
    }
    const decider = fakeDecision({
      answer: (_q, _id, state) =>
        (state as { item: { title: string } }).item.title === `Original title ${yes.docId}`
          ? 0.9
          : 0.1,
    });
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 1, llm: null, decider, notifier, recipient: RECIPIENT }, SLOT);
    const plan = planOf((await db.select().from(digests))[0]?.meta);
    expect(plan.ranking.decision?.model).toBe("fake-decision");
    expect(plan.ranking.decision?.counts).toEqual({
      inBand: 2,
      asked: 2,
      passed: 1,
      rejected: 1,
      fallback: 0,
    });
    expect(
      plan.ranking.decision?.events.map((e) => [e.eventId, e.R, e.probability, e.pass, e.fallback]),
    ).toEqual(
      expect.arrayContaining([
        [yes.eventId, 0.55, 0.9, true, false],
        [no.eventId, 0.65, 0.1, false, false],
      ]),
    );
    expect(plan.ranking.decision?.events[0]?.topic).toBe("Agent AI");
    expect(plan.ranking.rejected.decision_reject).toBe(1);
    expect(plan.ranking.passedGate).toBe(2);
    expect(typeof plan.ranking.ms).toBe("number");
  });

  test("không có LLM (chưa đặt khoá) vẫn gửi bản không tóm tắt", async () => {
    await addEvent();
    const notifier = fakeNotifier();
    const out = await runDigest(
      { db, profileId: 1, llm: null, notifier, recipient: RECIPIENT },
      SLOT,
    );
    expect(out).toMatchObject({ status: "sent", summarized: false, sentNow: 2 });
  });
});

describe("hàm thuần", () => {
  test("khung gửi: 07:00 giờ VN gần nhất không muộn hơn lúc chạy", () => {
    expect(digestSlot(new Date("2026-10-06T00:00:00Z"))).toEqual(SLOT);
    expect(digestSlot(new Date("2026-10-06T16:59:00Z"))).toEqual(SLOT); // 23:59 VN
    expect(digestSlot(new Date("2026-10-05T23:59:00Z"))).toEqual(new Date("2026-10-05T00:00:00Z"));
    expect(digestSlot(new Date("2026-10-06T17:30:00Z"))).toEqual(SLOT); // 00:30 Vietnam time on day 07
    expect(vnDate(SLOT)).toBe("06/10");
  });

  test("link: lượt đăng lại cùng URL là một bài; bài khác tối đa 3, còn lại +N", () => {
    const doc = (
      id: number,
      url: string,
      topicScore: number,
      engagement: number | null,
    ): ItemDoc => ({
      id,
      sourceId: 1,
      sourceName: "HN",
      kind: "hn",
      externalId: String(id),
      title: `t${id}`,
      publishedAt: null,
      url: `https://www.${url}`,
      urlCanonical: `https://${url}`,
      excerpt: "",
      signals: {},
      topicScore,
      engagement,
    });
    const { links, moreRelated } = buildLinks([
      doc(1, "a.com/x", 0.7, 5),
      doc(2, "a.com/x", 0.6, 300),
      doc(3, "b.com/y", 0.9, 1),
      doc(4, "c.com/z", 0.5, null),
      doc(5, "d.com/w", 0.4, null),
      doc(6, "e.com/v", 0.3, null),
    ]);
    expect(links.map((l) => [l.role, l.label])).toEqual([
      ["main", "b.com"],
      ["related", "a.com"],
      ["related", "c.com"],
      ["related", "d.com"],
      ["discussion", "HN"],
    ]);
    // Discussion: the post with the most interest.
    expect(links.at(-1)?.url).toBe("https://news.ycombinator.com/item?id=2");
    expect(moreRelated).toBe(1);
  });

  test("đọc JSON tóm tắt chung: bỏ rào markdown; thiếu mục thì báo lỗi", () => {
    const ok = parseSummaryBatch(
      'Đây:\n```json\n{"items":[{"n":1,"title":"A","summary":"Một câu tóm tắt đủ dài."}]}\n```',
      1,
    );
    expect(ok.get(1)?.title).toBe("A");
    expect(() =>
      parseSummaryBatch('{"items":[{"n":1,"title":"A","summary":"Một câu tóm tắt đủ dài."}]}', 2),
    ).toThrow("thiếu tóm tắt cho tin 2");
  });

  test("đọc JSON lời mở đầu: bỏ rào markdown; thiếu hoặc rỗng thì báo lỗi", () => {
    expect(parseIntro('Đây:\n```json\n{"intro":" Mở đầu "}\n```')).toBe("Mở đầu");
    expect(() => parseIntro('{"intro":"  "}')).toThrow("thiếu intro");
    expect(() => parseIntro("không có json")).toThrow();
  });

  test("lời mở đầu chỉ nhận tối đa 10 tiêu đề đầu, theo thứ tự", async () => {
    const seen: string[] = [];
    const llm = fakeLlm({
      reply(prompt) {
        seen.push(prompt);
        return '{"intro":"x"}';
      },
    });
    const titles = Array.from({ length: 12 }, (_, i) => `T${i + 1}`);
    expect(await generateIntro(llm, { context: "c", lang: "vi", titles })).toBe("x");
    expect(seen[0]?.split("\n")).toEqual(titles.slice(0, 10).map((t, i) => `Story ${i + 1}: ${t}`));
    expect(await generateIntro(null, { context: "c", lang: "vi", titles })).toBeNull();
  });
});

describe("chọn Gumbel top-k trong luồng thật", () => {
  const picked = (plan: DigestPlan) => plan.items.map((i) => i.eventId);
  const metaOf = async () => {
    const [dg] = await db.select().from(digests);
    return (dg?.meta ?? {}) as {
      selectSeed?: number;
      plan?: DigestPlan;
      learning?: SelectionLearning;
    };
  };
  /** 12 items with similar scores from two sources (at most 5 per source, so two sources are needed for 7 items). */
  const many = async () => {
    const [s2] = await db
      .insert(sources)
      .values({ kind: "hn", name: "HN2", cadence: "*/15 * * * *", trustScore: 0.6 })
      .returning({ id: sources.id });
    await db.insert(baselines).values([
      {
        metric: "relevance",
        sourceId: s2?.id ?? 0,
        topicId: topic,
        median: 0.4,
        p999: 0.8,
        n: 10_000,
        windowDays: 30,
      },
      {
        metric: "engagement",
        sourceId: s2?.id ?? 0,
        median: 1,
        p999: 7,
        n: 10_000,
        windowDays: 30,
      },
    ]);
    for (let i = 0; i < 12; i++) await addEvent(0.79, i % 2 ? (s2?.id ?? hn) : hn);
  };

  test("T mặc định 0,03 trong runDigest; lưu hạt giống, p_i của cả bể, 21 cặp, logP, T, số lần", async () => {
    await many();
    await runDigest(
      { db, profileId: 1, llm: null, notifier: fakeNotifier(), recipient: RECIPIENT },
      SLOT,
    );
    const m = await metaOf();
    const l = m.learning;
    expect(m.plan?.ranking.config.temperature).toBe(0.03);
    expect(l?.selectSeed).toBe(m.selectSeed ?? -1);
    expect(l?.simSeed).toBe(deriveSimSeed(m.selectSeed ?? 0));
    expect(l?.temperature).toBe(0.03);
    expect(l?.runs).toBe(10_000);
    expect(l?.pool.length).toBe(12);
    expect(l?.pool.filter((x) => x.sent).length).toBe(7);
    expect(l?.pool.every((x) => x.p >= 0 && x.p <= 1)).toBe(true);
    // Sent items must have p > 0 (the real selection itself shows it can be chosen).
    expect(l?.pool.filter((x) => x.sent).every((x) => x.p > 0)).toBe(true);
    expect(l?.pairs.length).toBe(21);
    expect(l?.pairs.every((x) => x.a < x.b && x.p >= 0 && x.p <= 1)).toBe(true);
    expect(typeof l?.logP).toBe("number");
    expect(l?.logP ?? 0).toBeLessThan(0);
  });

  test("cùng hạt giống ra cùng tập; hạt khác ra tập khác; không hạt thì xác định (T = 0)", async () => {
    await many();
    const deps = { db, profileId: 1, llm: null };
    const a1 = await buildPlan(deps, SLOT, undefined, 12345);
    const a2 = await buildPlan(deps, SLOT, undefined, 12345);
    expect(picked(a2)).toEqual(picked(a1));
    const sets = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      sets.add([...picked(await buildPlan(deps, SLOT, undefined, seed))].sort().join(","));
    }
    expect(sets.size).toBeGreaterThan(1);
    const n1 = await buildPlan(deps, SLOT);
    const n2 = await buildPlan(deps, SLOT);
    expect(n1.ranking.config.temperature).toBe(0);
    expect(picked(n2)).toEqual(picked(n1));
  });

  test("xem thử (buildPlan không hạt) không ghi dữ liệu học vào digests", async () => {
    await many();
    await buildPlan({ db, profileId: 1, llm: null }, SLOT);
    expect(await db.select().from(digests)).toHaveLength(0);
  });

  test("chạy lại khi plan chưa kịp lưu: dùng hạt đã lưu, ra đúng tập cũ", async () => {
    await many();
    const deps = { db, profileId: 1, llm: null, notifier: fakeNotifier(), recipient: RECIPIENT };
    await runDigest(deps, SLOT);
    const first = await metaOf();
    // Simulate a crash after saving the seed but before saving the plan.
    await db.delete(deliveries);
    await db.update(digests).set({ status: "sending", meta: { selectSeed: first.selectSeed } });
    await db.execute(sql`truncate candidate_pool`);
    await runDigest(deps, SLOT);
    const again = await metaOf();
    expect(again.selectSeed).toBe(first.selectSeed ?? -1);
    expect(picked(again.plan as DigestPlan)).toEqual(picked(first.plan as DigestPlan));
    expect(again.learning?.pool.map((x) => x.p)).toEqual(first.learning?.pool.map((x) => x.p));
  });

  test("mô phỏng lỗi: vẫn gửi tin, chỉ không có dữ liệu học", async () => {
    await many();
    const notifier = fakeNotifier();
    const out = await runDigest(
      {
        db,
        profileId: 1,
        llm: null,
        notifier,
        recipient: RECIPIENT,
        computeLearning: () => {
          throw new Error("mô phỏng hỏng");
        },
      },
      SLOT,
    );
    expect(out.status).toBe("sent");
    expect(notifier.sent.length).toBeGreaterThan(1);
    const m = await metaOf();
    expect(m.learning).toBeUndefined();
    expect(m.plan?.items.length).toBe(7);
  });
});
