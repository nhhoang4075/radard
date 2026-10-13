/**
 * ObjectStore ghi ra đĩa. Dùng khi dev và trong test; trên Railway thay bằng R2.
 *
 * Nội dung được nén gzip ở đây chứ không ở lõi, vì R2 có thể muốn nén khác (hoặc để
 * Cloudflare tự nén). Key đã có đuôi `.gz` nên hai adapter vẫn đọc được bản của nhau.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ObjectStore } from "@radard/core";

export function fsObjectStore(root: string): ObjectStore {
  const pathOf = (key: string) => join(root, key);
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, Bun.gzipSync(body));
    },
    async get(key) {
      const file = Bun.file(pathOf(key));
      if (!(await file.exists())) return null;
      return Bun.gunzipSync(new Uint8Array(await file.arrayBuffer()));
    },
    exists(key) {
      return Bun.file(pathOf(key)).exists();
    },
  };
}
