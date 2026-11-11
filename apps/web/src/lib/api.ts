/**
 * Client có kiểu của API Hono (`hc`). `AppType` lấy thẳng từ server (`apps/daemon/src/web/app.ts`), nên
 * đổi API ở server thì chỗ gọi báo lỗi kiểu ngay lúc build. Cùng origin, cookie phiên tự đi kèm.
 */
import type { AppType } from "@radard/daemon/app";
import { createAuthClient } from "better-auth/client";
import { hc } from "hono/client";

export const api = hc<AppType>("/api");
export const authClient = createAuthClient();

/** Lỗi HTTP có mã trạng thái, để phân biệt chưa đăng nhập (401) với chưa có hồ sơ (403). */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
