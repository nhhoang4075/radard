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
