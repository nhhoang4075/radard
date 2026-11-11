/** GET /api/me: name and profile of the current session. Mounted after `sessionMiddleware`. */
import { Hono } from "hono";
import type { SessionEnv } from "../middleware/session.ts";

export const meRoute = new Hono<SessionEnv>().get("/", (c) =>
  c.json({ name: c.get("userName"), profileId: c.get("profileId") }),
);
