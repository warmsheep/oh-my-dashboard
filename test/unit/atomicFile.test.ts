import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic } from "../../src/core/atomicFile";

type AtomicFs = Parameters<typeof writeFileAtomic>[2];

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
  sandboxes.push(dir);
  return dir;
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("writeFileAtomic cleanup must not mask the original error", () => {
  it("surfaces the write error when the tmp cleanup itself throws (write path)", () => {
    const failing: AtomicFs = {
      openSync: () => 3,
      writeFileSync: () => {
        throw errnoError("EIO", "write boom");
      },
      fsyncSync: () => undefined,
      closeSync: () => undefined,
      renameSync: () => undefined,
      rmSync: () => {
        // Windows: tmp file locked by AV/indexer at the exact moment of failure
        throw errnoError("EPERM", "cleanup boom");
      },
    };
    let caught: unknown;
    try {
      writeFileAtomic(path.join(sandbox(), "out.json"), "x", failing);
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("EIO");
    expect((caught as Error).message).toBe("write boom");
  });

  it("surfaces the rename error when the tmp cleanup itself throws (rename-exhausted path)", () => {
    const failing: AtomicFs = {
      openSync: () => 3,
      writeFileSync: () => undefined,
      fsyncSync: () => undefined,
      closeSync: () => undefined,
      renameSync: () => {
        // non-retryable code: breaks out of the retry loop immediately
        throw errnoError("ENOENT", "rename boom");
      },
      rmSync: () => {
        throw errnoError("EPERM", "cleanup boom");
      },
    };
    let caught: unknown;
    try {
      writeFileAtomic(path.join(sandbox(), "out.json"), "x", failing);
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((caught as Error).message).toBe("rename boom");
  });

  it("still writes and cleans up normally with the real fs", () => {
    const target = path.join(sandbox(), "out.json");
    writeFileAtomic(target, "content", fs);
    expect(fs.readFileSync(target, "utf8")).toBe("content");
  });
});
