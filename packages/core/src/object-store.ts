/**
 * Kho bản thô. Khi dev ghi ra đĩa, khi deploy ghi lên R2; lõi không biết là cái nào.
 *
 * Key theo hash nội dung, nên ghi lại cùng một nội dung là vô hại, và hai nguồn trả về
 * cùng một thứ thì chỉ tốn một chỗ lưu.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  exists(key: string): Promise<boolean>;
}

/** `raw/ab/abcdef….gz`: tách thư mục theo 2 ký tự đầu để một thư mục không có hàng triệu file. */
export function rawKey(sha256: string): string {
  return `raw/${sha256.slice(0, 2)}/${sha256}.gz`;
}
