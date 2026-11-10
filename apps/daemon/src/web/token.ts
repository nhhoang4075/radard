/**
 * Token theo dõi link: `v1.<digest_id>.<position>.<k>.<mac>`.
 *
 * `mac` = HMAC-SHA256 trên chuỗi `v1.<digest_id>.<position>.<k>`, cắt còn 128 bit, mã base64url
 * (22 ký tự). Nằm trong `apps/daemon` vì chỉ daemon dựng link (soạn tin) và kiểm link (route web);
 * hàm thuần, không đọc env, để test được.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_VERSION = "v1";
const MAC_BYTES = 16;
const MAC_CHARS = 22; // 16 byte → base64url không đệm
const MAX_DIGITS = 15; // trong khoảng số nguyên an toàn của JS

export interface TokenParts {
  digestId: number;
  position: number;
  k: number;
}

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

function macOf(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest()
    .subarray(0, MAC_BYTES)
    .toString("base64url");
}

/** Số nguyên không âm dạng chuẩn (không số 0 đứng đầu, không dấu), hoặc null. */
function parseCount(s: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(s) || s.length > MAX_DIGITS) return null;
  return Number(s);
}

/** Token đầy đủ. Ném lỗi nếu tham số không phải số nguyên không âm hoặc thiếu khoá. */
export function signToken(secret: string, p: TokenParts): string {
  if (!secret) throw new Error("thiếu khoá bí mật");
  if (!isCount(p.digestId) || !isCount(p.position) || !isCount(p.k))
    throw new Error("digestId, position, k phải là số nguyên không âm");
  const payload = `${TOKEN_VERSION}.${p.digestId}.${p.position}.${p.k}`;
  return `${payload}.${macOf(secret, payload)}`;
}

/** Kiểm token; trả các phần nếu hợp lệ, `null` nếu sai bất kỳ điều gì (không phân biệt lý do). */
export function verifyToken(secret: string | undefined, token: string): TokenParts | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) return null;
  const [, d, pos, kk, mac] = parts as [string, string, string, string, string];
  const digestId = parseCount(d);
  const position = parseCount(pos);
  const k = parseCount(kk);
  if (digestId === null || position === null || k === null) return null;
  if (mac.length !== MAC_CHARS) return null;
  const expected = Buffer.from(macOf(secret, `${TOKEN_VERSION}.${d}.${pos}.${kk}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { digestId, position, k };
}

/** URL theo dõi: `<baseUrl>/o/<token>` (bỏ dấu `/` cuối của baseUrl). */
export function buildTrackingUrl(opts: { baseUrl: string; secret: string } & TokenParts): string {
  const { baseUrl, secret, ...parts } = opts;
  return `${baseUrl.replace(/\/+$/, "")}/o/${signToken(secret, parts)}`;
}
