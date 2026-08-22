import * as fs from "node:fs";
import * as path from "node:path";

export type AtomicFs = Pick<
  typeof fs,
  "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "rmSync"
>;

/** Windows rename targets that are momentarily locked (AV scan, open handle) — worth retrying. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms);
}

/**
 * tmp-file + fsync + rename atomic write. On Windows, renaming over an existing file can
 * transiently fail with EPERM/EACCES/EBUSY (antivirus, indexer, an editor holding a handle),
 * so the rename retries with backoff before giving up; POSIX rename is atomic and unaffected.
 * The tmp file is removed on every failure path (write/fsync/rename).
 */
export function writeFileAtomic(filePath: string, content: string, fsMod: AtomicFs = fs): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const fd = fsMod.openSync(tmpPath, "w");
    try {
      fsMod.writeFileSync(fd, content, "utf8");
      fsMod.fsyncSync(fd);
    } finally {
      fsMod.closeSync(fd);
    }
  } catch (error) {
    fsMod.rmSync(tmpPath, { force: true });
    throw error;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fsMod.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RENAME_RETRY_CODES.has(code) || attempt === 4) {
        break;
      }
      sleepSync(50 * 2 ** attempt);
    }
  }
  fsMod.rmSync(tmpPath, { force: true });
  throw lastError;
}
