/**
 * Typed client for the Hono API (`hc`). `AppType` is taken directly from the server (`apps/daemon/src/web/app.ts`), so
 * an API change on the server makes the call sites report a type error at build time. Same origin, the session cookie is sent automatically.
 */
import type { AppType } from "@radard/daemon/app";
import { createAuthClient } from "better-auth/client";
import { hc } from "hono/client";

export const api = hc<AppType>("/api");
export const authClient = createAuthClient();

/** HTTP error with a status code, to tell not signed in (401) from no profile yet (403). */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
