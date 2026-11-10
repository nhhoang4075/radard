/**
 * Máy chủ HTTP (Hono) của vai trò `web`.
 *
 *   GET /healthz  → 200
 *   GET /o/:token → ghi lượt mở rồi 302 tới URL lấy từ DB
 *
 * Fail-closed: không có `LINK_SECRET` thì `/o/*` luôn 404. URL đích chỉ lấy từ `deliveries.meta`,
 * không bao giờ từ request. Mọi lỗi (token sai, không tìm thấy, URL lạ) đều là 404 trơn, không nêu lý do.
 */
import { createLogger } from "@radard/core";
import { type Database, deliveries } from "@radard/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { verifyToken } from "./token.ts";

const log = createLogger("web");
const DEDUP_WINDOW_MS = 24 * 60 * 60_000;
const UA_MAX = 200;

export interface WebOptions {
  db: Database;
  /** `LINK_SECRET`; thiếu thì `/o/*` trả 404. */
  secret: string | undefined;
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

  return {
    app,
    /** Chờ các lượt ghi đang dở (test và lúc tắt máy). */
    idle: async () => {
      await Promise.all([...pending]);
    },
  };
}
