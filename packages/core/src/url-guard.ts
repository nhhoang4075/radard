/**
 * SSRF protection for the untrusted-page fetch path: addresses posted by strangers (HN) must not lead radard into the internal
 * network, the cloud metadata service, or a non-web port.
 *
 * The pure parts (scheme, port, `isPublicAddress`) are separated from I/O; DNS resolution is injected
 * (`AddressResolver`) so tests need no network.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a hostname to ALL of its addresses (both A and AAAA). */
export type AddressResolver = (host: string) => Promise<string[]>;

export const defaultResolver: AddressResolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

/** Address not allowed (scheme, port or IP address); `reason` is written to the error column. */
export class UrlBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly url: string,
  ) {
    super(`URL bị chặn: ${reason}`);
  }
}

const ALLOWED_PORTS = new Set([80, 443]);

/** Max number of redirect hops when following them manually. */
export const MAX_REDIRECTS = 5;

/** Only http/https and ports 80/443; no I/O. Returns the parsed URL. */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlBlockedError("URL không hợp lệ", raw);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UrlBlockedError(`lược đồ ${u.protocol} không được phép`, raw);
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) throw new UrlBlockedError(`cổng ${port} không được phép`, raw);
  return u;
}

/** Host name to resolve: strips IPv6 square brackets and the trailing dot (`example.com.`). */
export function hostnameOf(u: URL): string {
  let h = u.hostname;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.$/, "");
}

/** The four bytes of an IPv4 address in the form `a.b.c.d`, or null. */
function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** The eight 16-bit groups of an IPv6 address (handles `::` and a dotted IPv4 tail), or null. */
function parseIPv6(input: string): number[] | null {
  const s = input.split("%")[0] ?? "";
  if (!s.includes(":")) return null;
  let head = s;
  let tail4: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail4 = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = `${s.slice(0, lastColon + 1)}0:0`; // placeholder for two groups, replaced later
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const gs: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      gs.push(Number.parseInt(g, 16));
    }
    return gs;
  };
  const a = toGroups(halves[0] ?? "");
  const b = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!a || !b) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - a.length - b.length;
    if (fill < 1) return null;
    groups = [...a, ...new Array<number>(fill).fill(0), ...b];
  } else {
    groups = a;
  }
  if (groups.length !== 8) return null;
  if (tail4.length) groups.splice(6, 2, ...tail4);
  return groups;
}

/** Non-public IPv4 ranges: [start address, prefix length]. */
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], // on Linux 0.0.0.0 points to the machine itself
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // includes 169.254.169.254 (metadata)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // old 6to4 relay
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 3], // multicast, reserved, broadcast (224.0.0.0 – 255.255.255.255)
];

const v4ToInt = ([a, b, c, d]: readonly [number, number, number, number]) =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const PRIVATE_V4_RANGES = PRIVATE_V4.map(([addr, bits]) => {
  const start = v4ToInt(parseIPv4(addr) ?? [0, 0, 0, 0]);
  const size = 2 ** (32 - bits);
  return [start, start + size - 1] as const;
});

function isPublicIPv4(octets: [number, number, number, number]): boolean {
  const n = v4ToInt(octets);
  return !PRIVATE_V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * IPv6 is public only within 2000::/3 (an allow-list: every other range such as fc00::/7,
 * fe80::/10, ff00::/8 is not), except Teredo 2001::/32, documentation 2001:db8::/32 and 3fff::/20.
 */
function isPublicGlobalV6(g0: number, g1: number): boolean {
  if (g0 < 0x2000 || g0 > 0x3fff) return false;
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return false;
  return !(g0 === 0x3fff && g1 <= 0x0fff);
}

/**
 * `true` when `address` (an IPv4 or IPv6 string) is a public address. A string that is not an address gives
 * `false` (fail-safe on errors). Pure function.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPublicIPv4(v4);
  const g = parseIPv6(address) as
    | [number, number, number, number, number, number, number, number]
    | null;
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  const embedded = (hi: number, lo: number): [number, number, number, number] => [
    hi >> 8,
    hi & 255,
    lo >> 8,
    lo & 255,
  ];
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::, ::1 and IPv4-compatible (::a.b.c.d): first 96 bits are zero.
  if (firstFiveZero && g5 === 0) {
    return g6 === 0 && g7 === 0 ? false : isPublicIPv4(embedded(g6, g7));
  }
  // Embedded IPv4: ::ffff:a.b.c.d
  if (firstFiveZero && g5 === 0xffff) return isPublicIPv4(embedded(g6, g7));
  // NAT64 64:ff9b::/96 carries IPv4 in the last 32 bits.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIPv4(embedded(g6, g7));
  }
  // ::ffff:0:a.b.c.d (IPv4-translated, ::ffff:0:0:0/96): not used on the public path.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return false;
  if (g0 === 0x2002) return isPublicIPv4(embedded(g1, g2)); // 6to4
  return isPublicGlobalV6(g0, g1); // includes 64:ff9b:1::/48 → not public
}

/** Result of checking a URL: the parsed URL and the CHECKED addresses (all public) to pin to the connection. */
export interface CheckedUrl {
  url: URL;
  addresses: string[];
  /** `true`: the host is already a bare IP address, no pinning needed. */
  literal: boolean;
}

/**
 * Checks a URL before sending a request: scheme, port, then EVERY address of the host must be public.
 * Also returns the checked addresses so the caller can connect directly to exactly them (prevents DNS rebinding:
 * `GetOptions.connectTo`), instead of letting `fetch` resolve again.
 */
export async function resolvePublicUrl(
  raw: string,
  resolve: AddressResolver = defaultResolver,
): Promise<CheckedUrl> {
  const u = checkUrlShape(raw);
  const host = hostnameOf(u);
  if (host === "") throw new UrlBlockedError("thiếu host", raw);
  const literal = isIP(host) !== 0;
  let addresses: string[];
  if (literal) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch (err) {
      throw new UrlBlockedError(
        `không phân giải được ${host}: ${err instanceof Error ? err.message : String(err)}`,
        raw,
      );
    }
  }
  if (addresses.length === 0) throw new UrlBlockedError(`${host} không có địa chỉ`, raw);
  const bad = addresses.find((a) => !isPublicAddress(a));
  if (bad !== undefined) throw new UrlBlockedError(`${host} trỏ tới địa chỉ riêng ${bad}`, raw);
  return { url: u, addresses, literal };
}

/** Like `resolvePublicUrl` but only returns the URL (when pinning is not needed). */
export async function assertPublicUrl(
  raw: string,
  resolve: AddressResolver = defaultResolver,
): Promise<URL> {
  return (await resolvePublicUrl(raw, resolve)).url;
}
