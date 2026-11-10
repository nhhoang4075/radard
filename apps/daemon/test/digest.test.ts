/**
 * Job điểm tin trên `radard_test` với Notifier giả và LLM giả: chạy lại không gửi trùng, chết giữa
 * chừng thì gửi tiếp phần thiếu, LLM hỏng thì gửi bản không tóm tắt, ngày yên ắng vẫn có tin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeDecision, fakeLlm } from "@radard/adapters/ai-fake";
import { fakeNotifier } from "@radard/adapters/notify-fake";
import {
  baselines,
  createDatabase,
  deliveries,
  digests,
  docText,
  docTopicScores,
  documents,
  eventDocuments,
  events,
  profile,
  runMigrations,
  sources,
  topics,
} from "@radard/db";
import { asc, eq, sql } from "drizzle-orm";
import {
  buildLinks,
  type DigestPlan,
  digestSlot,
  type ItemDoc,
  parseSummaries,
  runDigest,
  vnDate,
} from "../src/jobs/digest.ts";

import { addTopic } from "./topic-fixture.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 2 });
const RECIPIENT = "100000001";
/** 07:00 giờ VN ngày 06/10. */
const SLOT = new Date("2026-10-06T00:00:00Z");
const IN = new Date("2026-10-05T12:00:00Z");
let hn = 0;
let topic = 0;
let seq = 0;

async function addEvent(score = 0.79): Promise<{ eventId: number; docId: number }> {
  const id = ++seq;
  const [d] = await db
    .insert(documents)
    .values({
      sourceId: hn,
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

/** LLM giả trả đúng số mục có trong prompt. */
function goodLlm(topicOf: (n: number) => string | undefined = () => undefined) {
  const calls: { prompt: string; system?: string }[] = [];
  const llm = fakeLlm({
    reply(prompt, system) {
      calls.push({ prompt, system });
      const n = (prompt.match(/^Story \d+$/gm) ?? []).length;
      const items = Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        title: `Tiêu đề ${i + 1}`,
        summary: `Tóm tắt tin số ${i + 1}, đủ dài để qua kiểm tra.`,
        topic: topicOf(i + 1),
      }));
      return `\`\`\`json\n${JSON.stringify({ intro: "Sáng nay nổi bật là agent.", items })}\n\`\`\``;
    },
  });
  return { llm, calls };
}

beforeAll(async () => {
  await runMigrations(TEST_URL);
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate sources, events, profile, topics, documents, digests restart identity cascade`,
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
    { metric: "coverage", median: Math.log(2), p999: 2, n: 10_000, windowDays: 30 },
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
    const { llm, calls } = goodLlm();
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
    // Bài gốc (tên miền, link đầy đủ) và trang thảo luận HN do adapter khai báo.
    expect(item?.links?.map((l) => [l.role, l.label])).toEqual([
      ["main", "site1.com"],
      ["discussion", "HN"],
    ]);
    expect(item?.links?.[1]?.url).toBe("https://news.ycombinator.com/item?id=1001");
    expect(item?.actions?.map((a) => a.id)).toEqual(["like", "dislike"]);
    // Prompt đọc bối cảnh từ hồ sơ, không viết cứng.
    expect(calls[0]?.system).toContain("I build AI agents.");
    expect(calls[0]?.system).toContain("Vietnamese");

    expect(await positions()).toEqual([0, 1, 2, 3, 4]);
    const [dg] = await db.select().from(digests);
    expect(dg?.status).toBe("sent");
    const plan = planOf(dg?.meta);
    expect(plan.items.map((i) => i.score.S > 0)).toEqual([true, true, true, true]);
    expect(plan.ranking.config.priors).toEqual({ [hn]: 0.6 });

    const again = await runDigest(deps, SLOT);
    expect(again).toMatchObject({ status: "already_sent", sentNow: 0 });
    expect(notifier.sent).toHaveLength(5);
    expect(calls).toHaveLength(1);
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

    // Trong lúc chờ có thêm sự kiện mới: plan đã lưu nên không chọn lại.
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
    expect(calls).toHaveLength(1);
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
    expect(calls).toBe(2);
    const [header, item] = notifier.sent.map((s) => s.msg);
    expect(header?.lines.join(" ")).toContain("Bản không tóm tắt");
    expect(item?.title).toBe("1. Original title 1");
    expect(item?.lines).toEqual(["Chủ đề: Agent AI · HN"]);
    const plan = planOf((await db.select().from(digests))[0]?.meta);
    expect(plan.llm?.error).toBeTruthy();
  });

  test("ngày không có tin nào vượt sàn: một tin ngắn, không gọi LLM (D5)", async () => {
    await addEvent(0.5); // dưới cổng R
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
    await addEvent(0.66); // z = 0,65: qua cổng R, S ≈ 0,5 dưới sàn 0,59
    await addEvent(0.66);
    const notifier = fakeNotifier();
    await runDigest({ db, profileId: 1, llm: null, notifier, recipient: RECIPIENT }, SLOT);
    expect(notifier.sent[0]?.msg.lines[1]).toBe(
      "Có 2 sự kiện thuộc các chủ đề bạn quan tâm nhưng chưa đủ mức đáng đọc.",
    );
  });

  test("nhãn chủ đề: lấy chủ đề LLM chọn nếu nằm trong danh sách, không thì nhãn embedding", async () => {
    const infra = await addTopic(db, "GPU & inference", { embedText: "inference" });
    // Chủ đề thư viện có phạm vi; chủ đề tự thêm ("Agent AI" ở đây) chỉ có tên.
    await db
      .update(topics)
      .set({ labelGuide: "GPUs and AI chips. Not: chip company finance (→ Kinh doanh AI)." })
      .where(eq(topics.id, infra));
    await addEvent();
    await addEvent();
    const notifier = fakeNotifier();
    const { llm, calls } = goodLlm((n) => (n === 1 ? "GPU & inference" : "Không có chủ đề này"));
    await runDigest({ db, profileId: 1, llm, notifier, recipient: RECIPIENT }, SLOT);
    const system = calls[0]?.system ?? "";
    expect(system).toContain(
      '  - "Agent AI"\n  - "GPU & inference": GPUs and AI chips. Not: chip company finance (→ Kinh doanh AI).\n',
    );
    // Hai quy tắc phân xử khi tin hợp hai chủ đề.
    expect(system).toContain("A more specific topic beats a general one");
    expect(system).toContain("The application domain beats the data modality");
    // Nhãn embedding không được đưa vào prompt.
    expect(calls[0]?.prompt).not.toContain("Agent AI");
    expect(notifier.sent[1]?.msg.lines.at(-1)).toBe("Chủ đề: GPU & inference · HN");
    expect(notifier.sent[2]?.msg.lines.at(-1)).toBe("Chủ đề: Agent AI · HN");
    const plan = planOf((await db.select().from(digests))[0]?.meta);
    expect(plan.items.map((i) => [i.topicSource, i.topicByEmbedding])).toEqual([
      ["llm", "Agent AI"],
      ["embedding", "Agent AI"],
    ]);
  });

  test("plan ghi lại cổng vùng xám: từng sự kiện đã hỏi, xác suất, qua hay loại", async () => {
    await addEvent(); // R ≈ 0,98: qua không hỏi
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
    expect(digestSlot(new Date("2026-10-06T17:30:00Z"))).toEqual(SLOT); // 00:30 VN ngày 07
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
    // Thảo luận: lượt đăng nhiều người quan tâm nhất.
    expect(links.at(-1)?.url).toBe("https://news.ycombinator.com/item?id=2");
    expect(moreRelated).toBe(1);
  });

  test("đọc JSON của model: bỏ rào markdown; thiếu mục thì báo lỗi", () => {
    const ok = parseSummaries(
      'Đây:\n```json\n{"intro":"Mở đầu","items":[{"n":1,"title":"A","summary":"Một câu tóm tắt đủ dài."}]}\n```',
      1,
    );
    expect(ok.intro).toBe("Mở đầu");
    expect(ok.items.get(1)?.title).toBe("A");
    expect(() =>
      parseSummaries(
        '{"intro":"x","items":[{"n":1,"title":"A","summary":"Một câu tóm tắt đủ dài."}]}',
        2,
      ),
    ).toThrow("thiếu tóm tắt cho tin 2");
  });
});
