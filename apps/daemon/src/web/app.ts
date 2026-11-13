/**
 * HTTP server (Hono) for the `web` role.
 *
 *   GET /healthz   → 200
 *   GET /o/:token  → records the open, then 302 to the URL taken from the DB
 *   /api/auth/*    → Better Auth (GitHub/Google sign-in, sessions)
 *   /api/*         → Hono API; every route except `providers` goes through `sessionMiddleware` (401/403)
 *   everything else → build files of `apps/web` (SPA fallback), same origin so the session cookie stays simple
 *
 * Fail-closed: without `LINK_SECRET`, `/o/*` always returns 404. The target URL is taken only from `deliveries.meta`,
 * never from the request. Every error (wrong token, not found, odd URL) is a plain 404, with no reason given.
 */
import { createLogger, type FeedbackState, type LlmProvider, type Notifier } from "@radard/core";
import { type Database, deliveries, telegramMessagesOfFeedItem } from "@radard/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Auth } from "./auth.ts";
import type { SocialProviderId } from "./auth-config.ts";
import { originGuard } from "./middleware/origin.ts";
import { type SessionEnv, sessionMiddleware } from "./middleware/session.ts";
import { eventsRoute } from "./routes/events.ts";
import { feedRoute } from "./routes/feed.ts";
import { feedbackRoute } from "./routes/feedback.ts";
import { impressionsRoute } from "./routes/impressions.ts";
import { meRoute } from "./routes/me.ts";
import { createStaticHandler, DEFAULT_WEB_DIST } from "./static.ts";
import { verifyToken } from "./token.ts";

const log = createLogger("web");
const DEDUP_WINDOW_MS = 24 * 60 * 60_000;
const UA_MAX = 200;

export interface WebOptions {
  db: Database;
  /** `LINK_SECRET`; if missing, `/o/*` returns 404. */
  secret: string | undefined;
  /** Sign-in; if missing (config incomplete), every `/api/*` returns 503 while the other routes still run. */
  auth?: { auth: Auth; providers: SocialProviderId[] } | null;
  /** Build directory of `apps/web`; defaults to `apps/web/dist`. */
  webDist?: string;
  /** Model that writes "Với ttôi?"... */
  llm?: LlmProvider | null;
  /** Quota for "Với tôi?" per profile per day. */
  forMeDailyLimit?: number;
  /** Clock, injected so tests can simulate time. */
  now?: () => Date;
  /** Delivery channel (Telegram); if missing, web feedback does not refresh buttons of sent messages. */
  notifier?: Notifier | null;
}

/**
 * After a web feedback write, re-render the buttons of every Telegram message sent for that item to that profile.
 * Best effort: failures are logged, never thrown.
 */
export async function refreshSentFeedback(
  db: Database,
  notifier: Notifier,
  e: { profileId: number; feedItemId: number; state: FeedbackState },
): Promise<void> {
  try {
    const msgs = await telegramMessagesOfFeedItem(db, e);
    for (const m of msgs) {
      try {
        await notifier.refreshFeedbackMark(m.recipient, m.messageId, e.state, { forMe: m.forMe });
      } catch (err) {
        log.error("cập nhật nút phản hồi lỗi", { code: errCode(err), feedItemId: e.feedItemId });
      }
    }
  } catch (err) {
    log.error("tra tin đã gửi lỗi", { code: errCode(err), feedItemId: e.feedItemId });
  }
}

/** Common preview-bot user agents (Telegram…) or prefetch headers. A flag only. */
export function isPrefetchRequest(headers: Headers): boolean {
  const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""} ${headers.get("x-moz") ?? ""}`;
  if (/prefetch|prerender/i.test(purpose)) return true;
  return /TelegramBot|bot\b|crawler|spider|preview/i.test(headers.get("user-agent") ?? "");
}

/** Short error code for the log: the driver's error message includes the query parameters (with the UA), so it is not logged. */
function errCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : err instanceof Error ? err.name : "unknown";
}

/** Redirects only to http/https; any port is allowed (unlike `checkUrlShape`, which is for fetching pages). */
function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Records an open, skipped if the same (delivery, link) already has a row in the last 24 hours. An advisory lock per pair so
 * two concurrent requests queue up, so check-then-write cannot be bypassed.
 */
export async function recordLinkOpen(
  db: Database,
  o: {
    profileId: number;
    deliveryId: number;
    linkIndex: number;
    now: Date;
    userAgent: string | null;
    isPrefetch: boolean;
  },
): Promise<boolean> {
  const cutoff = new Date(o.now.getTime() - DEDUP_WINDOW_MS).toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`link_opens:${o.deliveryId}:${o.linkIndex}`}, 0))`,
    );
    const res = await tx.execute(sql`
      insert into link_opens (profile_id, delivery_id, link_index, opened_at, user_agent, is_prefetch)
      select ${o.profileId}::int, ${o.deliveryId}::bigint, ${o.linkIndex}::int, ${o.now.toISOString()}::timestamptz,
             ${o.userAgent}::text, ${o.isPrefetch}::boolean
      where not exists (
        select 1 from link_opens
        where delivery_id = ${o.deliveryId}::bigint and link_index = ${o.linkIndex}::int
          and opened_at > ${cutoff}::timestamptz
      )
      returning id`);
    return res.length > 0;
  });
}

/**
 * API under `/api`. `providers` is the only public route; `sessionMiddleware` comes right after it, so
 * every route added later (via `.route(...)` below) returns 401/403 when there is no session and profile.
 * Kept as one chained call so that `AppType` can be inferred for the `hc` client of `apps/web`.
 */
export function buildApi(deps: {
  db: Database;
  auth: Auth;
  providers: SocialProviderId[];
  llm?: LlmProvider | null;
  forMeDailyLimit?: number;
  now?: () => Date;
  onFeedbackRecorded?: (e: { profileId: number; feedItemId: number; state: FeedbackState }) => void;
}) {
  return (
    new Hono<SessionEnv>()
      .get("/providers", (c) => c.json({ providers: deps.providers }))
      // CSRF: an unknown Origin on POST/PUT… returns 403 (even without a session).
      .use("*", originGuard(deps.auth.options.baseURL ?? ""))
      .use("*", sessionMiddleware(deps))
      .route("/me", meRoute)
      .route("/feed", feedRoute({ db: deps.db }))
      .route(
        "/feedback",
        feedbackRoute({
          db: deps.db,
          ...(deps.onFeedbackRecorded ? { onRecorded: deps.onFeedbackRecorded } : {}),
        }),
      )
      .route("/impressions", impressionsRoute({ db: deps.db }))
      .route(
        "/events",
        eventsRoute({
          db: deps.db,
          llm: deps.llm ?? null,
          ...(deps.forMeDailyLimit === undefined ? {} : { dailyLimit: deps.forMeDailyLimit }),
          ...(deps.now ? { now: deps.now } : {}),
        }),
      )
  );
}
export type AppType = ReturnType<typeof buildApi>;

export function createWebApp(opts: WebOptions) {
  const { db, secret } = opts;
  const now = opts.now ?? (() => new Date());
  const pending = new Set<Promise<unknown>>();
  const app = new Hono();
  const notFound = () =>
    new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/o/:token", async (c) => {
    const parts = verifyToken(secret, c.req.param("token"));
    if (!parts) return notFound();

    let row: { profileId: number; id: number; meta: Record<string, unknown> } | undefined;
    try {
      [row] = await db
        .select({ id: deliveries.id, profileId: deliveries.profileId, meta: deliveries.meta })
        .from(deliveries)
        .where(
          and(eq(deliveries.digestId, parts.digestId), eq(deliveries.position, parts.position)),
        )
        .limit(1);
    } catch (err) {
      log.error("tra delivery lỗi", { code: errCode(err) });
      return notFound();
    }
    const links = row?.meta?.links;
    const link = Array.isArray(links)
      ? (links[parts.k] as { url?: unknown } | undefined)
      : undefined;
    const target = safeHttpUrl(link?.url);
    if (!row || !target) return notFound();

    // Written after the target is known; a write error is only logged and does not break the redirect.
    const { id: deliveryId, profileId } = row;
    const task = recordLinkOpen(db, {
      profileId,
      deliveryId,
      linkIndex: parts.k,
      now: now(),
      userAgent: c.req.header("user-agent")?.slice(0, UA_MAX) || null,
      isPrefetch: isPrefetchRequest(c.req.raw.headers),
    })
      .catch((err) => log.error("ghi lượt mở lỗi", { code: errCode(err), deliveryId }))
      .finally(() => pending.delete(task));
    pending.add(task);

    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  });

  // --- API and sign-in. Registration order matters: public routes first, `requireProfile` after. ---
  const { auth } = opts;
  const notifier = opts.notifier ?? null;
  if (auth) {
    const authHandler = auth.auth.handler;
    app.on(["GET", "POST"], "/api/auth/*", (c) => authHandler(c.req.raw));
    app.route(
      "/api",
      buildApi({
        db,
        auth: auth.auth,
        providers: auth.providers,
        llm: opts.llm ?? null,
        ...(notifier
          ? {
              onFeedbackRecorded: (e: {
                profileId: number;
                feedItemId: number;
                state: FeedbackState;
              }) => {
                const task = refreshSentFeedback(db, notifier, e).finally(() =>
                  pending.delete(task),
                );
                pending.add(task);
              },
            }
          : {}),
        ...(opts.forMeDailyLimit === undefined ? {} : { forMeDailyLimit: opts.forMeDailyLimit }),
        now,
      }),
    );
  } else {
    app.all("/api/*", (c) => c.json({ error: "auth_not_configured" }, 503));
  }
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  app.all("*", createStaticHandler(opts.webDist ?? DEFAULT_WEB_DIST));

  return {
    app,
    /** Waits for in-flight writes to finish (tests and shutdown). */
    idle: async () => {
      await Promise.all([...pending]);
    },
  };
}
