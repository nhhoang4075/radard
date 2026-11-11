/**
 * POST /api/events/:id/for-me: the event's "Với tôi?" text for the session's profile (decision 11/11/2026).
 * Mounted AFTER `sessionMiddleware`. `profileId` is taken only from the session context, never from the request; the event must
 * be in that profile's own feed (checked by `explainForProfile`), otherwise return 404 and do not call the model.
 *
 *   GET /api/events/:id → 200 event details (only if in the profile's feed) · 404 not_found
 *
 *   200 { text, cached } · 404 not in the profile · 429 quota exceeded · 503 model not configured / model error
 */
import type { LlmProvider } from "@radard/core";
import { type Database, feedItemForEvent } from "@radard/db";
import { Hono } from "hono";
import { sourcesLine } from "../../jobs/digest.ts";
import { explainForProfile } from "../../jobs/for-me.ts";
import { loadItemDocs } from "../../jobs/item-docs.ts";
import type { SessionEnv } from "../middleware/session.ts";

const MAX_DOCS = 20;

export function eventsRoute(deps: {
  db: Database;
  llm: LlmProvider | null;
  dailyLimit?: number;
  now?: () => Date;
}) {
  return new Hono<SessionEnv>()
    .get("/:id", async (c) => {
      const raw = c.req.param("id");
      if (!/^\d{1,15}$/.test(raw)) return c.json({ error: "not_found" }, 404);
      const eventId = Number(raw);
      const profileId = c.get("profileId");
      const found = await feedItemForEvent(deps.db, { profileId, eventId });
      if (!found) return c.json({ error: "not_found" }, 404);
      const { view, row } = found;
      const docs = (
        (
          await loadItemDocs(deps.db, [
            { eventId, documentIds: row.documentIds, topicId: row.topicId },
          ])
        ).get(eventId) ?? []
      ).slice(0, MAX_DOCS);
      // The "why" line built the same way as digest.ts, without using a model.
      const why = [
        view.updated ? "Cập nhật" : null,
        view.topic ? `Chủ đề: ${view.topic}` : null,
        sourcesLine(docs),
      ]
        .filter(Boolean)
        .join(" · ");
      return c.json({
        eventId,
        title: view.title,
        summary: view.summary,
        topic: view.topic,
        docs: docs.map((d) => ({
          title: d.title ?? d.url,
          url: d.url,
          sourceName: d.sourceName,
          publishedAt: d.publishedAt ? d.publishedAt.toISOString() : null,
        })),
        score: view.score,
        why,
        feedItemId: view.feedItemId,
        feedback: view.feedback,
      });
    })
    .post("/:id/for-me", async (c) => {
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
