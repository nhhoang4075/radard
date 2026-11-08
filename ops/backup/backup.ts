/**
 * Sao lưu Postgres lên R2, chạy một lần rồi thoát (Railway Cron gọi mỗi đêm).
 *
 * `pg_dump -Fc` (nén, restore được bằng pg_restore) → kiểm tra file → tải lên
 * `<BACKUP_PREFIX>radard-YYYYMMDD-HHMMSS.dump` → so kích thước → xoá bản cũ, giữ `BACKUP_KEEP` bản
 * mới nhất (mặc định 14). Chỉ xoá sau khi bản mới đã lên và kiểm tra xong; lỗi ở bước nào cũng
 * thoát mã khác 0 để Railway ghi nhận lượt chạy hỏng và không xoá gì.
 *
 * Biến môi trường: DATABASE_URL, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY;
 * tuỳ chọn BACKUP_PREFIX (mặc định `backup/`), BACKUP_KEEP (mặc định 14).
 */
import { S3Client } from "bun";

const DEFAULT_KEEP = 14;
const NAME = /radard-\d{8}-\d{6}\.dump$/;

/** `radard-20261109-200000.dump`: giờ UTC, sắp theo tên là sắp theo thời gian. */
export function backupName(now: Date): string {
  const p = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return `radard-${p}.dump`;
}

/** Các key phải xoá để còn `keep` bản mới nhất. Chỉ đụng file đúng tên sao lưu, không xoá gì khác. */
export function keysToDelete(keys: string[], keep: number): string[] {
  const backups = keys.filter((k) => NAME.test(k)).sort();
  return backups.slice(0, Math.max(0, backups.length - keep));
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`thiếu biến môi trường ${name}`);
  return v;
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} thoát với mã ${p.exitCode}`);
  return out;
}

async function main() {
  const prefix = process.env.BACKUP_PREFIX ?? "backup/";
  const keep = Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("BACKUP_KEEP phải là số nguyên ≥ 1");
  const s3 = new S3Client({
    endpoint: need("R2_ENDPOINT"),
    bucket: need("R2_BUCKET"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  });

  const name = backupName(new Date());
  const key = `${prefix}${name}`;
  const file = `/tmp/${name}`;

  process.stdout.write(`sao lưu bắt đầu key=${key}\n`);
  await run(["pg_dump", "-Fc", "--no-owner", `--dbname=${need("DATABASE_URL")}`, "-f", file]);
  const size = Bun.file(file).size;
  const toc = await run(["pg_restore", "-l", file]);
  const tables = toc.split("\n").filter((l) => l.includes("TABLE DATA")).length;
  if (size === 0 || tables === 0)
    throw new Error(`file dump không hợp lệ size=${size} tables=${tables}`);

  await s3.write(key, Bun.file(file));
  const remote = (await s3.stat(key)).size;
  if (remote !== size) throw new Error(`kích thước trên R2 (${remote}) khác file local (${size})`);
  process.stdout.write(`sao lưu đã lên R2 key=${key} bytes=${size} tables=${tables}\n`);

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.list({ prefix, continuationToken: token });
    for (const c of page.contents ?? []) keys.push(c.key);
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  const old = keysToDelete(keys, keep);
  for (const k of old) await s3.delete(k);
  process.stdout.write(`sao lưu xong giữ=${keys.length - old.length} xoá=${old.length}\n`);
  await Bun.file(file).delete();
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`sao lưu LỖI: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
