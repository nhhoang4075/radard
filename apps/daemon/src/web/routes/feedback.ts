/**
 * PUT /api/feedback { feedItemId, kind: "like"|"dislike" } → 200 { state } · 404 not_found · 400.
 * Clicking the currently selected button again deselects it ("none"). Mounted after `sessionMiddleware`.
 */
import { type Database, recordFeedFeedback } from "@radard/db";
import { Hono } from "hono";
import { z } from "zod";
import { readJsonBody } from "../lib/body.ts";
import type { SessionEnv } from "../middleware/session.ts";

const body = z.strictObject({
  feedItemId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["like", "dislike"]),
});

export function feedbackRoute(deps: { db: Database }) {
  return new Hono<SessionEnv>().put("/", async (c) => {
    const raw = await readJsonBody(c);
    if (!raw.ok)
      return c.json({ error: raw.status === 413 ? "too_large" : "bad_request" }, raw.status);
    const b = body.safeParse(raw.value);
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const r = await recordFeedFeedback(deps.db, { profileId: c.get("profileId"), ...b.data });
    if (!r.ok) return c.json({ error: "not_found" }, 404);
    return c.json({ state: r.state });
  });
}
