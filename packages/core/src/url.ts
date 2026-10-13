/**
 * Chuẩn hoá URL để hai link cùng trỏ một bài được nhận ra là một.
 *
 * Chỉ bỏ những thứ chắc chắn không đổi nội dung: tham số theo dõi, fragment, `www.`,
 * dấu `/` cuối, thứ tự tham số. Tham số khác giữ nguyên, vì nhiều trang dùng query để
 * chọn bài (`?id=123`), bỏ đi là gộp nhầm hai bài khác nhau.
 */
const TRACKING = new RegExp(
  `^(${[
    "utm_\\w+", // chuẩn UTM (Google Analytics và gần như mọi công cụ marketing)
    // Mã click do nền tảng quảng cáo tự gắn: mỗi lần click một mã khác nhau.
    "fbclid", // Facebook
    "gclid|dclid|gbraid|wbraid", // Google Ads, Campaign Manager, biến thể cho iOS
    "msclkid", // Microsoft Advertising (Bing)
    "twclid", // X Ads
    "ttclid", // TikTok Ads
    "li_fat_id", // LinkedIn
    "yclid", // Yandex Direct
    // Email marketing: nhiều mã gắn với TỪNG người nhận, không nên làm khoá hay lan đi.
    "mc_cid|mc_eid", // Mailchimp
    "_hsenc|_hsmi", // HubSpot
    "mkt_tok", // Marketo
    // Chia sẻ trên mạng xã hội.
    "ref_src", // X
    "igshid", // Instagram
  ].join("|")})$`,
  "i",
);

/**
 * Tham số chỉ là theo dõi trên vài host cụ thể. `ref` KHÔNG có ở đây: trên GitHub nó là tên
 * nhánh hoặc tag (`?ref=v2`), bỏ đi là gộp hai phiên bản khác nhau thành một.
 */
const TRACKING_BY_HOST: Record<string, RegExp> = {
  "youtube.com": /^si$/i,
  "youtu.be": /^si$/i,
  "open.spotify.com": /^si$/i,
};

function isTracking(host: string, param: string): boolean {
  return TRACKING.test(param) || (TRACKING_BY_HOST[host]?.test(param) ?? false);
}

export function canonicalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  // Chỉ dùng làm khoá so sánh, không dùng để tải, nên gộp http và https là an toàn.
  if (url.protocol === "http:") url.protocol = "https:";

  const kept = [...url.searchParams.entries()]
    .filter(([k]) => !isTracking(url.hostname, k))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of kept) url.searchParams.append(k, v);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}
