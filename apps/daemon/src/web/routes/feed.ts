/**
 * Feed web (docs/cau-truc-web.html mục 4). Mount SAU `sessionMiddleware`; `profileId` chỉ lấy từ context
 * phiên. Không có SQL ở đây: mọi truy vấn là hàm của @radard/db nhận `profileId` bắt buộc.
 *
 *   GET /api/feed?date=&cursor=&limit=  → 200 { snapshotId, date, total, items[], nextCursor } · 404 no_snapshot · 400
 *   GET /api/feed/dates                 → 200 { dates: [{ date, snapshotId, itemCount }] } (tối đa 60)
 */
import {
  type Database,
  feedDates,
  feedItemsView,
  feedSnapshotOnDate,
  latestFeedSnapshot,
  vnDate,
} from "@radard/db";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionEnv } from "../middleware/session.ts";

const query = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional(),
});

/** Con trỏ không trong suốt với client: gắn với bản chụp để không dùng nhầm sang ngày khác. */
export function encodeCursor(snapshotId: number, after: number): string {
  return Buffer.from(`c1:${snapshotId}:${after}`).toString("base64url");
}
export function decodeCursor(raw: string): { snapshotId: number; after: number } | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return null;
  const m = /^c1:(\d{1,15}):(\d{1,9})$/.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (!m) return null;
  const after = Number(m[2]);
  return after >= 1 ? { snapshotId: Number(m[1]), after } : null;
}

export function feedRoute(deps: { db: Database }) {
  return new Hono<SessionEnv>()
    .get("/", async (c) => {
      const profileId = c.get("profileId");
      const q = query.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "bad_request" }, 400);
      const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
      if (q.data.cursor && !cursor) return c.json({ error: "invalid_cursor" }, 400);

      const snap = q.data.date
        ? await feedSnapshotOnDate(deps.db, profileId, q.data.date)
        : await latestFeedSnapshot(deps.db, profileId);
      if (!snap) return c.json({ error: "no_snapshot" }, 404);
      if (cursor && cursor.snapshotId !== snap.id) return c.json({ error: "invalid_cursor" }, 400);

      const page = await feedItemsView(deps.db, {
        profileId,
        snapshotId: snap.id,
        ...(cursor ? { after: cursor.after } : {}),
        limit: q.data.limit ?? 10,
      });
      return c.json({
        snapshotId: snap.id,
        date: vnDate(snap.periodEnd),
        total: snap.itemCount ?? 0,
        items: page.items,
        nextCursor: page.nextAfter === null ? null : encodeCursor(snap.id, page.nextAfter),
      });
    })
    .get("/dates", async (c) =>
      c.json({ dates: await feedDates(deps.db, { profileId: c.get("profileId"), limit: 60 }) }),
    );
}
