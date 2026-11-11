/**
 * POST /api/events/:id/for-me: câu "Với tôi?" của sự kiện cho hồ sơ của phiên (quyết định 11/11/2026).
 * Mount SAU `sessionMiddleware`. `profileId` chỉ lấy từ context phiên, không từ request; sự kiện phải
 * nằm trong feed của chính hồ sơ đó (`explainForProfile` kiểm), không thì 404 và không gọi model.
 *
 *   200 { text, cached } · 404 không thuộc hồ sơ · 429 hết hạn mức · 503 chưa cấu hình model / model lỗi
 */
import type { LlmProvider } from "@radard/core";
import type { Database } from "@radard/db";
import { Hono } from "hono";
import { explainForProfile } from "../../jobs/for-me.ts";
import type { SessionEnv } from "../middleware/session.ts";

export function eventsRoute(deps: {
  db: Database;
  llm: LlmProvider | null;
  dailyLimit?: number;
  now?: () => Date;
}) {
  return new Hono<SessionEnv>().post("/:id/for-me", async (c) => {
    const raw = c.req.param("id");
    const eventId = /^\d{1,15}$/.test(raw) ? Number(raw) : null;
    if (eventId === null) return c.json({ error: "not_found" }, 404);
    const r = await explainForProfile(
      {
        db: deps.db,
        llm: deps.llm,
        ...(deps.dailyLimit === undefined ? {} : { dailyLimit: deps.dailyLimit }),
        ...(deps.now ? { now: deps.now } : {}),
      },
      { profileId: c.get("profileId"), eventId },
    );
    switch (r.status) {
      case "ok":
        return c.json({ text: r.text, cached: r.cached });
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "limit":
        return c.json({ error: "limit_reached" }, 429);
      case "unavailable":
        return c.json({ error: "llm_unavailable" }, 503);
    }
  });
}
