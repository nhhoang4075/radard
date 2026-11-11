/**
 * Content hash. Always normalize Unicode to NFC first: Vietnamese has two ways to encode diacritics
 * (precomposed and combining); the same-looking text could hash differently and break dedup.
 */
export function nfc(text: string): string {
  return text.normalize("NFC");
}

export function sha256(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(typeof input === "string" ? nfc(input) : input);
  return hasher.digest("hex");
}
