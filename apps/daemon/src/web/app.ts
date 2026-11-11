/**
 * Máy chủ HTTP (Hono) của vai trò `web`.
 *
 *   GET /healthz   → 200
 *   GET /o/:token  → ghi lượt mở rồi 302 tới URL lấy từ DB
 *   /api/auth/*    → Better Auth (đăng nhập GitHub/Google, phiên)
 *   /api/*         → API Hono; mọi route trừ `providers` đi qua `sessionMiddleware` (401/403)
 *   còn lại        → file build của `apps/web` (SPA fallback), cùng origin nên cookie phiên đơn giản
 *
 * Fail-closed: không có `LINK_SECRET` thì `/o/*` luôn 404. URL đích chỉ lấy từ `deliveries.meta`,
 * không bao giờ từ request. Mọi lỗi (token sai, không tìm thấy, URL lạ) đều là 404 trơn, không nêu lý do.
 */
import { createLogger, type LlmProvider } from "@radard/core";
import { type Database, deliveries } from "@radard/db";
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
  /** `LINK_SECRET`; thiếu thì `/o/*` trả 404. */
  secret: string | undefined;
  /** Đăng nhập; thiếu (cấu hình chưa đủ) thì mọi `/api/*` trả 503, các route khác vẫn chạy. */
  auth?: { auth: Auth; providers: SocialProviderId[] } | null;
  /** Thư mục build của `apps/web`; mặc định `apps/web/dist`. */
  webDist?: string;
  /** Model viết "Với ttôi?"... */
  llm?: LlmProvider | null;
  /** Hạn mức "Với tôi?" mỗi hồ sơ mỗi ngày. */
  forMeDailyLimit?: number;
  /** Đồng hồ, tiêm vào để test giả lập thời gian. */
  now?: () => Date;
}

/** UA bot xem trước thường gặp (Telegram…) hoặc header prefetch. Chỉ là cờ. */
export function isPrefetchRequest(headers: Headers): boolean {
  const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""} ${headers.get("x-moz") ?? ""}`;
  if (/prefetch|prerender/i.test(purpose)) return true;
  return /TelegramBot|bot\b|crawler|spider|preview/i.test(headers.get("user-agent") ?? "");
}

/** Mã lỗi ngắn để log: thông điệp lỗi của driver kèm cả tham số truy vấn (có UA), nên không ghi. */
function errCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : err instanceof Error ? err.name : "unknown";
}

/** Chỉ chuyển hướng tới http/https; không giới hạn cổng (khác `checkUrlShape`, vốn dành cho việc tải trang). */
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
 * Ghi một lượt mở, bỏ qua nếu cùng (delivery, link) đã có dòng trong 24 giờ qua. Khoá tư vấn theo cặp
 * làm hai request đồng thời nối đuôi nhau, nên kiểm-rồi-ghi không bị lách.
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
 * API dưới `/api`. `providers` là route công khai duy nhất; `sessionMiddleware` đứng ngay sau nó nên
 * mọi route thêm sau (qua `.route(...)` bên dưới) đều bị 401/403 khi chưa có phiên và hồ sơ.
 * Giữ ở dạng một chuỗi gọi liền để `AppType` suy ra được cho client `hc` của `apps/web`.
 */
export function buildApi(deps: {
  db: Database;
  auth: Auth;
  providers: SocialProviderId[];
  llm?: LlmProvider | null;
  forMeDailyLimit?: number;
  now?: () => Date;
}) {
  return (
    new Hono<SessionEnv>()
      .get("/providers", (c) => c.json({ providers: deps.providers }))
      // CSRF: Origin lạ trên POST/PUT… là 403 (kể cả khi chưa có phiên).
      .use("*", originGuard(deps.auth.options.baseURL ?? ""))
      .use("*", sessionMiddleware(deps))
      .route("/me", meRoute)
      .route("/feed", feedRoute({ db: deps.db }))
      .route("/feedback", feedbackRoute({ db: deps.db }))
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

    // Ghi sau khi đã có đích; lỗi ghi chỉ log, không làm hỏng chuyển hướng.
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

  // --- API và đăng nhập. Thứ tự đăng ký quan trọng: route công khai trước, `requireProfile` sau. ---
  const { auth } = opts;
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
    /** Chờ các lượt ghi đang dở (test và lúc tắt máy). */
    idle: async () => {
      await Promise.all([...pending]);
    },
  };
}
