/**
 * Raw content store. In dev it writes to disk, on deploy it writes to R2; the core does not know which.
 *
 * Keys are content hashes, so writing the same content again is harmless, and if two sources return
 * the same thing it only costs one stored copy.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  exists(key: string): Promise<boolean>;
}

/** `raw/ab/abcdef….gz`: split into folders by the first 2 characters so one folder never holds millions of files. */
export function rawKey(sha256: string): string {
  return `raw/${sha256.slice(0, 2)}/${sha256}.gz`;
}
