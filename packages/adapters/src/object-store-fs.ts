/**
 * ObjectStore writes to disk. Used in dev and tests; on Railway it is replaced by R2.
 *
 * Content is gzip-compressed here rather than in the core, because R2 may want to compress differently (or to let
 * Cloudflare do it itself). Keys already carry the `.gz` suffix, so both adapters can still read each other's copies.
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
