/**
 * Đọc thân request thành JSON bất kể content-type (`navigator.sendBeacon` có thể gửi text/plain),
 * có giới hạn kích thước: quá giới hạn thì dừng đọc ngay, không gom hết vào bộ nhớ.
 */
import type { Context } from "hono";

export const MAX_BODY_BYTES = 16 * 1024;

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

export async function readJsonBody(c: Context, max = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) return { ok: false, status: 413 };
  const stream = c.req.raw.body;
  if (!stream) return { ok: false, status: 400 };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}
