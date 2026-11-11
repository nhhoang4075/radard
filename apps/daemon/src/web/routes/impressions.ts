/**
 * POST /api/impressions { items: [{ snapshotId, position }] } (tối đa 100) → 204 (kể cả trùng) · 400.
 * Có một mục không thuộc hồ sơ hoặc vị trí không tồn tại thì 400 { error: "invalid", invalid } và không
 * ghi gì. Thân đọc thành JSON bất kể content-type (sendBeacon gửi text/plain), tối đa 16 KB.
 * `seen_at` là giờ máy chủ. Mount sau `sessionMiddleware`.
 */
import { type Database, recordImpressions } from "@radard/db";
import { Hono } from "hono";
import { z } from "zod";
import { readJsonBody } from "../lib/body.ts";
import type { SessionEnv } from "../middleware/session.ts";

const body = z.strictObject({
  items: z
    .array(
      z.strictObject({
        snapshotId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        position: z.number().int().positive().max(2_147_483_647),
      }),
    )
    .max(100),
});

export function impressionsRoute(deps: { db: Database }) {
  return new Hono<SessionEnv>().post("/", async (c) => {
    const raw = await readJsonBody(c);
    if (!raw.ok)
      return c.json({ error: raw.status === 413 ? "too_large" : "bad_request" }, raw.status);
    const b = body.safeParse(raw.value);
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const r = await recordImpressions(deps.db, c.get("profileId"), b.data.items);
    if (!r.ok) return c.json({ error: "invalid" as const, invalid: r.invalid }, 400);
    return c.body(null, 204);
  });
}
