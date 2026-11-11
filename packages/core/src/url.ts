/**
 * Normalizes URLs so two links pointing to the same article are recognized as one.
 *
 * Only removes things that certainly do not change content: tracking parameters, fragment, `www.`,
 * trailing `/`, parameter order. Other parameters are kept, because many sites use the query to
 * pick the article (`?id=123`); removing it would wrongly merge two different articles.
 */
const TRACKING = new RegExp(
  `^(${[
    "utm_\\w+", // UTM standard (Google Analytics and almost every marketing tool)
    // Click IDs added automatically by ad platforms: a different ID on every click.
    "fbclid", // Facebook
    "gclid|dclid|gbraid|wbraid", // Google Ads, Campaign Manager, iOS variants
    "msclkid", // Microsoft Advertising (Bing)
    "twclid", // X Ads
    "ttclid", // TikTok Ads
    "li_fat_id", // LinkedIn
    "yclid", // Yandex Direct
    // Email marketing: many IDs attached to EACH recipient; they should not become a key or spread.
    "mc_cid|mc_eid", // Mailchimp
    "_hsenc|_hsmi", // HubSpot
    "mkt_tok", // Marketo
    // Social network sharing.
    "ref_src", // X
    "igshid", // Instagram
  ].join("|")})$`,
  "i",
);

/**
 * Tracking-only parameters on a few specific hosts. `ref` is NOT here: on GitHub it is the branch
 * or tag name (`?ref=v2`); removing it would merge two different versions into one.
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
  // Only used as a comparison key, never to fetch, so merging http and https is safe.
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
