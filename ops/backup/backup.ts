/**
 * Postgres backup to R2, runs once then exits (Railway Cron calls it every night).
 *
 * `pg_dump -Fc` (compressed, restorable with pg_restore) → check the file → upload as
 * `<BACKUP_PREFIX>radard-YYYYMMDD-HHMMSS.dump` → compare size → delete old ones, keeping the `BACKUP_KEEP` newest
 * (default 14). Deletes only after the new copy is uploaded and checked; a failure at any step
 * exits non-zero so Railway records a failed run and nothing is deleted.
 *
 * Environment: DATABASE_URL, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY;
 * optional BACKUP_PREFIX (default `backup/`), BACKUP_KEEP (default 14).
 */
import { S3Client } from "bun";

const DEFAULT_KEEP = 14;
const NAME = /radard-\d{8}-\d{6}\.dump$/;

/** `radard-20261109-200000.dump`: UTC time, so sorting by name is sorting by time. */
export function backupName(now: Date): string {
  const p = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return `radard-${p}.dump`;
}

/** Keys to delete so only the `keep` newest remain. Touches only files named like backups, nothing else. */
export function keysToDelete(keys: string[], keep: number): string[] {
  const backups = keys.filter((k) => NAME.test(k)).sort();
  return backups.slice(0, Math.max(0, backups.length - keep));
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} exited with code ${p.exitCode}`);
  return out;
}

async function main() {
  const prefix = process.env.BACKUP_PREFIX ?? "backup/";
  const keep = Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("BACKUP_KEEP must be an integer >= 1");
  const s3 = new S3Client({
    endpoint: need("R2_ENDPOINT"),
    bucket: need("R2_BUCKET"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  });

  const name = backupName(new Date());
  const key = `${prefix}${name}`;
  const file = `/tmp/${name}`;

  process.stdout.write(`backup started key=${key}\n`);
  await run(["pg_dump", "-Fc", "--no-owner", `--dbname=${need("DATABASE_URL")}`, "-f", file]);
  const size = Bun.file(file).size;
  const toc = await run(["pg_restore", "-l", file]);
  const tables = toc.split("\n").filter((l) => l.includes("TABLE DATA")).length;
  if (size === 0 || tables === 0)
    throw new Error(`invalid dump file size=${size} tables=${tables}`);

  await s3.write(key, Bun.file(file));
  const remote = (await s3.stat(key)).size;
  if (remote !== size) throw new Error(`size on R2 (${remote}) differs from local file (${size})`);
  process.stdout.write(`backup uploaded to R2 key=${key} bytes=${size} tables=${tables}\n`);

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.list({ prefix, continuationToken: token });
    for (const c of page.contents ?? []) keys.push(c.key);
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  const old = keysToDelete(keys, keep);
  for (const k of old) await s3.delete(k);
  process.stdout.write(`backup done kept=${keys.length - old.length} deleted=${old.length}\n`);
  await Bun.file(file).delete();
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`backup ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
