/**
 * ObjectStore on Cloudflare R2 (via the S3-compatible API of `Bun.S3Client`). Used when deployed;
 * in dev and tests the disk store is used.
 *
 * Content is gzip-compressed exactly like the disk store, with the same key `raw/ab/<sha>.gz`. So moving data
 * from a machine up is just copying the files in `data/` to the bucket as they are, without recompressing.
 */
import type { ObjectStore } from "@radard/core";

export interface R2Options {
  /** `https://<account-id>.r2.cloudflarestorage.com`, or `http://localhost:9000` with MinIO. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2ObjectStore(opts: R2Options): ObjectStore {
  // R2 has no regions; "auto" is the value Cloudflare requires for S3 signatures.
  const s3 = new Bun.S3Client({ ...opts, region: "auto" });
  return {
    async put(key, body) {
      await s3.write(key, Bun.gzipSync(body), { type: "application/gzip" });
    },
    async get(key) {
      try {
        return Bun.gunzipSync(new Uint8Array(await s3.file(key).arrayBuffer()));
      } catch (err) {
        if ((err as { code?: string }).code === "NoSuchKey") return null;
        throw err;
      }
    },
    exists(key) {
      return s3.exists(key);
    },
  };
}

/**
 * Copies the already-compressed files in `root/raw` (disk store) to the bucket, same keys. Keys already on
 * the bucket are skipped, so re-running after an interruption is safe.
 */
export async function pushFsToR2(
  root: string,
  opts: R2Options,
  run: { concurrency?: number; limit?: number; onProgress?: (done: number) => void } = {},
): Promise<{ files: number; uploaded: number; skipped: number }> {
  const s3 = new Bun.S3Client({ ...opts, region: "auto" });
  const keys = [...new Bun.Glob("raw/**/*.gz").scanSync({ cwd: root })].sort().slice(0, run.limit);
  const out = { files: keys.length, uploaded: 0, skipped: 0 };
  const queue = [...keys];
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      if (await s3.exists(key)) out.skipped++;
      else {
        await s3.write(key, Bun.file(`${root}/${key}`), { type: "application/gzip" });
        out.uploaded++;
      }
      const done = out.uploaded + out.skipped;
      if (done % 1000 === 0) run.onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: run.concurrency ?? 16 }, worker));
  return out;
}
