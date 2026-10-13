/**
 * Hash nội dung. Luôn chuẩn hoá Unicode NFC trước: tiếng Việt có hai cách mã hoá dấu
 * (dựng sẵn và tổ hợp), cùng một chữ nhìn giống hệt mà hash khác nhau thì dedup hỏng.
 */
export function nfc(text: string): string {
  return text.normalize("NFC");
}

export function sha256(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(typeof input === "string" ? nfc(input) : input);
  return hasher.digest("hex");
}
