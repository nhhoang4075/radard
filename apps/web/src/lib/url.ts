/** Chỉ cho http(s) làm đích liên kết ngoài; scheme khác (javascript:, data:…) bị bỏ. Trả `undefined` nếu không an toàn. */
export function safeUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const p = new URL(raw);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : undefined;
  } catch {
    return undefined;
  }
}
