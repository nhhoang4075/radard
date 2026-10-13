/**
 * ObjectStore trên Cloudflare R2 (qua API tương thích S3 của `Bun.S3Client`). Dùng khi deploy;
 * khi dev và trong test dùng bản ghi đĩa.
 *
 * Nội dung được nén gzip giống hệt bản ghi đĩa, với cùng key `raw/ab/<sha>.gz`. Vì vậy chuyển dữ
 * liệu từ máy lên chỉ là chép nguyên các file trong `data/` lên bucket, không phải nén lại.
 */
import type { ObjectStore } from "@radard/core";

export interface R2Options {
  /** `https://<account-id>.r2.cloudflarestorage.com`, hoặc `http://localhost:9000` với MinIO. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2ObjectStore(opts: R2Options): ObjectStore {
  // R2 không có vùng; "auto" là giá trị Cloudflare yêu cầu cho chữ ký S3.
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
 * Chép nguyên các file đã nén trong `root/raw` (bản ghi đĩa) lên bucket, cùng key. Key đã có trên
 * bucket thì bỏ qua, nên chạy lại sau khi đứt giữa chừng là an toàn.
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
