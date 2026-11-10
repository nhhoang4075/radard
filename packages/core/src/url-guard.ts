/**
 * Chặn SSRF cho đường tải trang lạ: địa chỉ do người lạ đăng (HN) không được dẫn radard vào mạng
 * nội bộ, dịch vụ metadata của đám mây hay một cổng không phải web.
 *
 * Phần thuần (lược đồ, cổng, `isPublicAddress`) tách khỏi I/O; phần phân giải DNS được tiêm vào
 * (`AddressResolver`) để test không cần mạng.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Phân giải tên miền thành MỌI địa chỉ của nó (A lẫn AAAA). */
export type AddressResolver = (host: string) => Promise<string[]>;

export const defaultResolver: AddressResolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

/** Địa chỉ không được phép (lược đồ, cổng hay địa chỉ IP); `reason` ghi vào cột lỗi. */
export class UrlBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly url: string,
  ) {
    super(`URL bị chặn: ${reason}`);
  }
}

const ALLOWED_PORTS = new Set([80, 443]);

/** Số hop redirect tối đa khi đi theo tay. */
export const MAX_REDIRECTS = 5;

/** Chỉ http/https và cổng 80/443; không I/O. Trả về URL đã parse. */
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

/** Tên host để phân giải: bỏ ngoặc vuông của IPv6 và dấu chấm cuối (`example.com.`). */
export function hostnameOf(u: URL): string {
  let h = u.hostname;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.$/, "");
}

/** Bốn byte của IPv4 dạng `a.b.c.d`, hoặc null. */
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

/** Tám nhóm 16 bit của IPv6 (hiểu `::` và đuôi IPv4 dạng chấm), hoặc null. */
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
    head = `${s.slice(0, lastColon + 1)}0:0`; // giữ chỗ cho hai nhóm, thay sau
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

/** Dải IPv4 không công khai: [địa chỉ đầu, độ dài tiền tố]. */
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], // trên Linux 0.0.0.0 trỏ về chính máy mình
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // gồm 169.254.169.254 (metadata)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay cũ
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 3], // multicast, dành riêng, broadcast (224.0.0.0 – 255.255.255.255)
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
 * IPv6 chỉ công khai khi nằm trong 2000::/3 (danh sách cho phép: mọi dải khác như fc00::/7,
 * fe80::/10, ff00::/8 đều không), trừ Teredo 2001::/32, tài liệu 2001:db8::/32 và 3fff::/20.
 */
function isPublicGlobalV6(g0: number, g1: number): boolean {
  if (g0 < 0x2000 || g0 > 0x3fff) return false;
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return false;
  return !(g0 === 0x3fff && g1 <= 0x0fff);
}

/**
 * `true` khi `address` (chuỗi IPv4 hoặc IPv6) là địa chỉ công khai. Chuỗi không phải địa chỉ thì
 * `false` (an toàn khi lỗi). Hàm thuần.
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
  // ::, ::1 và IPv4 tương thích (::a.b.c.d): 96 bit đầu bằng 0.
  if (firstFiveZero && g5 === 0) {
    return g6 === 0 && g7 === 0 ? false : isPublicIPv4(embedded(g6, g7));
  }
  // IPv4 nhúng: ::ffff:a.b.c.d
  if (firstFiveZero && g5 === 0xffff) return isPublicIPv4(embedded(g6, g7));
  // NAT64 64:ff9b::/96 mang IPv4 ở 32 bit cuối.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIPv4(embedded(g6, g7));
  }
  // ::ffff:0:a.b.c.d (IPv4-translated, ::ffff:0:0:0/96): không dùng trên đường công khai.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return false;
  if (g0 === 0x2002) return isPublicIPv4(embedded(g1, g2)); // 6to4
  return isPublicGlobalV6(g0, g1); // gồm cả 64:ff9b:1::/48 → không công khai
}

/**
 * Kiểm một URL trước khi gửi request: lược đồ, cổng, rồi MỌI địa chỉ của host phải là công khai.
 *
 * TODO(spec: SSRF ghim địa chỉ): hàm này phân giải DNS rồi `fetch` phân giải lại, nên kẻ điều khiển
 * DNS có thể trả địa chỉ công khai lúc kiểm và địa chỉ nội bộ lúc kết nối (DNS rebinding). `fetch`
 * của Bun không cho chọn IP gọn; cần chặn thêm ở tầng mạng.
 */
export async function assertPublicUrl(
  raw: string,
  resolve: AddressResolver = defaultResolver,
): Promise<URL> {
  const u = checkUrlShape(raw);
  const host = hostnameOf(u);
  if (host === "") throw new UrlBlockedError("thiếu host", raw);
  let addresses: string[];
  if (isIP(host)) {
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
  return u;
}
