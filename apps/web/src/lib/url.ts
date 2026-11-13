/** Only http(s) is allowed as an external link target; other schemes (javascript:, data:…) are dropped. Returns `undefined` if unsafe. */
export function safeUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const p = new URL(raw);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : undefined;
  } catch {
    return undefined;
  }
}

/** Host of an http(s) link without a leading `www.` (e.g. `github.com`); `undefined` if the link is unsafe. */
export function hostOf(raw: string | null | undefined): string | undefined {
  const href = safeUrl(raw);
  return href ? new URL(href).hostname.replace(/^www\./, "") : undefined;
}
