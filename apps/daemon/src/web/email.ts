/** Normalizes an email for comparison: trims whitespace at both ends, lowercases. Not an email → `null`. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  if (/\s/.test(email)) return null;
  return email;
}
