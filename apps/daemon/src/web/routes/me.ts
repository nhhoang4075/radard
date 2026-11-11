/** GET /api/me: tên và hồ sơ của phiên hiện tại. Mount sau `sessionMiddleware`. */
import { Hono } from "hono";
import type { SessionEnv } from "../middleware/session.ts";

export const meRoute = new Hono<SessionEnv>().get("/", (c) =>
  c.json({ name: c.get("userName"), profileId: c.get("profileId") }),
);
