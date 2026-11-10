/**
 * Phục vụ file build của `apps/web` cùng origin với API, kèm SPA fallback: đường dẫn không phải file
 * thì trả `index.html` để TanStack Router tự xử lý. Chỉ GET/HEAD. Thư mục build thiếu thì 404 trơn.
 */
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { Context } from "hono";

/** `apps/web/dist`, tính từ vị trí file này (apps/daemon/src/web). */
export const DEFAULT_WEB_DIST = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../../web/dist",
);

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

async function fileResponse(path: string, immutable: boolean): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

export function createStaticHandler(distDir: string) {
  const root = resolve(distDir);
  return async (c: Context): Promise<Response> => {
    const notFound = () =>
      new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return notFound();

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return notFound();
    }
    if (pathname.includes("\0")) return notFound();
    // Chặn thoát khỏi thư mục build (`..`, đường dẫn tuyệt đối).
    const target = resolve(join(root, normalize(`.${pathname}`)));
    const inside = target === root || target.startsWith(root + sep);
    const isFileRequest = /\.[a-z0-9]+$/i.test(pathname);

    if (inside && pathname !== "/" && isFileRequest) {
      const res = await fileResponse(target, pathname.startsWith("/assets/"));
      if (res) return res;
      return notFound(); // file có đuôi mà không có: không fallback về trang chủ
    }
    return (await fileResponse(join(root, "index.html"), false)) ?? notFound();
  };
}
