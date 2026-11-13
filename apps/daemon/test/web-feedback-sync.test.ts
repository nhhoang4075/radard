/**
 * Web feedback → Telegram keyboard refresh, and Telegram feedback → web read. Expected values come from the task
 * brief: a web write refreshes exactly the Telegram deliveries of THAT profile and item; failures and a missing
 * notifier never change the HTTP result.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeNotifier } from "@radard/adapters/notify-fake";
import {
  createDatabase,
  deliveries,
  digests,
  feedItems,
  feedSnapshots,
  invites,
  profile,
  runMigrations,
  sources,
} from "@radard/db";
import { testUtils } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { recordFeedback } from "../src/jobs/feedback.ts";
import { createWebApp } from "../src/web/app.ts";
import { createAuth } from "../src/web/auth.ts";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/radard_test";
const db = createDatabase(TEST_URL, { max: 4 });
const OWNER = "chu.du.an@example.com";
const GUEST = "khach@example.com";
const BASE = "http://localhost:8080";
const D10 = new Date("2026-11-10T00:00:00Z");

const auth = createAuth({
  db,
  config: {
    secret: "khoa-thu-nghiem-0123456789-0123456789",
    baseURL: BASE,
    bootstrapOwnerEmails: [OWNER],
    providers: {},
  },
  plugins: [testUtils()],
});

async function login(email: string): Promise<Headers> {
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

let hA: Headers;
let profileB = 0;
let itemA = 0;
let itemB = 0;
let srcId = 0;
let seq = 0;

async function feedItem(profileId: number, snapshotId: number, eventId: number) {
  const [row] = await db
    .insert(feedItems)
    .values({
      profileId,
      snapshotId,
      position: 1,
      eventId,
      documentIds: [],
      sourceId: srcId,
      title: `Tin ${eventId}`,
      score: 0.5,
      penalty: 0,
      r: 1,
      p: 1,
      c: 1,
      a: 1,
      f: 1,
      u: 0,
      n: 1,
      reserved: false,
    })
    .returning({ id: feedItems.id });
  return row?.id ?? 0;
}

async function delivery(o: {
  profileId: number;
  feedItemId: number | null;
  channel?: string;
  recipient: string;
  messageId: string;
  kind?: string;
}) {
  const [dg] = await db
    .insert(digests)
    .values({
      profileId: o.profileId,
      channel: o.channel ?? "telegram",
      recipient: o.recipient,
      periodStart: D10,
      periodEnd: new Date(D10.getTime() + ++seq * 1000),
      lang: "vi",
    })
    .returning({ id: digests.id });
  await db.insert(deliveries).values({
    profileId: o.profileId,
    digestId: dg?.id ?? null,
    channel: o.channel ?? "telegram",
    recipient: o.recipient,
    messageId: o.messageId,
    kind: o.kind ?? "event",
    eventId: (o.kind ?? "event") === "event" ? 101 : null,
    position: 1,
    body: "x",
    feedItemId: o.feedItemId,
  });
}

const put = (
  app: { request: (p: string, i: RequestInit) => Response | Promise<Response> },
  id: number,
  kind: string,
) => {
  const h = new Headers(hA);
  return app.request("/api/feedback", {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ feedItemId: id, kind }),
  });
};

beforeAll(async () => {
  await runMigrations(TEST_URL);
});
afterAll(async () => {
  await db.$bun.close();
});

beforeEach(async () => {
  seq = 0;
  await db.execute(
    sql`truncate "user", session, account, verification, invites, sources, documents, profile, topics, event_summaries restart identity cascade`,
  );
  await db.insert(profile).values({ id: 1, promptContext: "A", displayLang: "vi" });
  await db.insert(invites).values({ email: GUEST });
  hA = await login(OWNER);
  const hB = await login(GUEST);
  const probe = createWebApp({ db, secret: undefined, auth: { auth, providers: [] } }).app;
  profileB = (await (await probe.request("/api/me", { headers: hB })).json()).profileId;
  const [s] = await db
    .insert(sources)
    .values({ kind: "hn", name: "HN", cadence: "*/15 * * * *", trustScore: 0.6 })
    .returning({ id: sources.id });
  srcId = s?.id ?? 0;
  const snap = async (profileId: number) =>
    (
      await db
        .insert(feedSnapshots)
        .values({
          profileId,
          periodStart: new Date(D10.getTime() - 86_400_000),
          periodEnd: D10,
          status: "ready",
          selectSeed: 1,
          itemCount: 1,
        })
        .returning({ id: feedSnapshots.id })
    )[0]?.id ?? 0;
  itemA = await feedItem(1, await snap(1), 101);
  itemB = await feedItem(profileB, await snap(profileB), 101);
  // Profile 1: two Telegram messages for itemA (two chats) plus a web delivery and a message of another item.
  await delivery({ profileId: 1, feedItemId: itemA, recipient: "111", messageId: "10" });
  await delivery({ profileId: 1, feedItemId: itemA, recipient: "222", messageId: "11" });
  await delivery({
    profileId: 1,
    feedItemId: itemA,
    channel: "discord",
    recipient: "d",
    messageId: "12",
  });
  await delivery({
    profileId: 1,
    feedItemId: null,
    recipient: "111",
    messageId: "13",
    kind: "header",
  });
  // Profile B: a message for ITS item (same event) must stay untouched.
  await delivery({ profileId: profileB, feedItemId: itemB, recipient: "333", messageId: "20" });
});

describe("web feedback refreshes Telegram messages", () => {
  test("like → state like for exactly the profile+item Telegram deliveries; toggle off → none", async () => {
    const n = fakeNotifier();
    const w = createWebApp({ db, secret: undefined, auth: { auth, providers: [] }, notifier: n });
    expect((await put(w.app, itemA, "like")).status).toBe(200);
    await w.idle();
    expect(n.refreshed).toEqual([
      { recipient: "111", messageId: "10", state: "like", forMe: true },
      { recipient: "222", messageId: "11", state: "like", forMe: true },
    ]);
    n.refreshed.length = 0;
    const res = await put(w.app, itemA, "like");
    expect((await res.json()).state).toBe("none");
    await w.idle();
    expect(n.refreshed.map((r) => [r.messageId, r.state])).toEqual([
      ["10", "none"],
      ["11", "none"],
    ]);
  });

  test("another profile's delivery is never refreshed; a rejected write refreshes nothing", async () => {
    const n = fakeNotifier();
    const w = createWebApp({ db, secret: undefined, auth: { auth, providers: [] }, notifier: n });
    // Profile 1 tries to rate profile B's item: 404, nothing refreshed.
    expect((await put(w.app, itemB, "like")).status).toBe(404);
    await w.idle();
    expect(n.refreshed).toEqual([]);
    await put(w.app, itemA, "dislike");
    await w.idle();
    expect(n.refreshed.some((r) => r.messageId === "20" || r.recipient === "333")).toBe(false);
    expect(n.refreshed.every((r) => r.state === "dislike")).toBe(true);
  });

  test("notifier failure does not change the HTTP result", async () => {
    const n = fakeNotifier();
    n.refreshError = new Error("telegram down");
    const w = createWebApp({ db, secret: undefined, auth: { auth, providers: [] }, notifier: n });
    const res = await put(w.app, itemA, "like");
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("like");
    await w.idle();
    expect(n.refreshed).toEqual([]);
  });

  test("no notifier: no error", async () => {
    const w = createWebApp({ db, secret: undefined, auth: { auth, providers: [] } });
    const res = await put(w.app, itemA, "like");
    expect(res.status).toBe(200);
    await w.idle();
  });
});

describe("Telegram feedback is visible on the web", () => {
  test("a press recorded through the Telegram path shows in GET /api/feed", async () => {
    await recordFeedback(
      db,
      { channel: "telegram", recipient: "111", messageId: "10", kind: "like", sourceId: "cb:1" },
      1,
    );
    const w = createWebApp({ db, secret: undefined, auth: { auth, providers: [] } });
    const res = await w.app.request("/api/events/101", { headers: hA });
    expect((await res.json()).feedback).toBe("like");
  });
});
