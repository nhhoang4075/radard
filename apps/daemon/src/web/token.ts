/**
 * Link-tracking token: `v1.<digest_id>.<position>.<k>.<mac>`.
 *
 * `mac` = HMAC-SHA256 over the string `v1.<digest_id>.<position>.<k>`, cut to 128 bits, base64url-encoded
 * (22 characters). It lives in `apps/daemon` because only the daemon builds links (composes messages) and checks them (web route);
 * a pure function with no env reads, so it can be tested.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_VERSION = "v1";
const MAC_BYTES = 16;
const MAC_CHARS = 22; // 16 bytes → base64url without padding
const MAX_DIGITS = 15; // within JS's safe integer range

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

/** Canonical non-negative integer (no leading zero, no sign), or null. */
function parseCount(s: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(s) || s.length > MAX_DIGITS) return null;
  return Number(s);
}

/** Full token. Throws if a parameter is not a non-negative integer or the key is missing. */
export function signToken(secret: string, p: TokenParts): string {
  if (!secret) throw new Error("thiếu khoá bí mật");
  if (!isCount(p.digestId) || !isCount(p.position) || !isCount(p.k))
    throw new Error("digestId, position, k phải là số nguyên không âm");
  const payload = `${TOKEN_VERSION}.${p.digestId}.${p.position}.${p.k}`;
  return `${payload}.${macOf(secret, payload)}`;
}

/** Verifies a token; returns the parts if valid, `null` if anything is wrong (without saying which). */
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

/** Tracking URL: `<baseUrl>/o/<token>` (trailing `/` of baseUrl removed). */
export function buildTrackingUrl(opts: { baseUrl: string; secret: string } & TokenParts): string {
  const { baseUrl, secret, ...parts } = opts;
  return `${baseUrl.replace(/\/+$/, "")}/o/${signToken(secret, parts)}`;
}
