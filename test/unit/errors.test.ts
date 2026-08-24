import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { errorDetail, errorMessage, FRIENDLY_ERRORS } from "../../src/core/errors";
import { JsoncSyntaxError } from "../../src/core/jsoncEditor";

describe("FRIENDLY_ERRORS — every coded Error maps to its Chinese message", () => {
  it("maps each entry by exact message match", () => {
    for (const [code, friendly] of Object.entries(FRIENDLY_ERRORS)) {
      expect(errorMessage(new Error(code))).toBe(friendly);
    }
  });

  it("covers every SCREAMING_SNAKE error code thrown in src/core (source-scan guard)", () => {
    const coreDir = path.resolve(__dirname, "../../src/core");
    const thrown = new Set<string>();
    for (const file of readdirSync(coreDir)) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(path.join(coreDir, file), "utf8");
      for (const match of source.matchAll(/new Error\("([A-Z][A-Z_]+)"\)/g)) {
        thrown.add(match[1]!);
      }
    }
    expect(thrown.size).toBeGreaterThan(0);
    const uncovered = [...thrown].filter((code) => !(code in FRIENDLY_ERRORS));
    expect(uncovered).toEqual([]);
  });

  it("contains the canonical codes used by core layers", () => {
    expect(FRIENDLY_ERRORS["CONFIG_UNREADABLE"]).toContain("无法读取");
    expect(FRIENDLY_ERRORS["PRESET_ALREADY_EXISTS"]).toBe("同名模板已存在");
    expect(FRIENDLY_ERRORS["MIMO_COOKIE_INVALID"]).toContain("MiMo Cookie");
  });

  it("also maps plain-string throws (not only Error instances)", () => {
    expect(errorMessage("PRESET_NOT_FOUND")).toBe("模板不存在");
  });
});

describe("errorMessage — JsoncSyntaxError shape", () => {
  it("reports the attached errors count", () => {
    const error = new JsoncSyntaxError([
      { offset: 1, length: 1, message: "Parse error code 1" },
      { offset: 9, length: 2, message: "Parse error code 2" },
    ]);
    expect(errorMessage(error)).toBe("配置文件存在 JSONC 语法错误（2 处），请先修复后再试");
  });

  it("derives the count from the message when no errors array is attached", () => {
    const error = new Error("JSONC syntax errors: 3");
    error.name = "JsoncSyntaxError";
    expect(errorMessage(error)).toBe("配置文件存在 JSONC 语法错误（3 处），请先修复后再试");
  });

  it("falls back to 1 处 when neither source carries a count", () => {
    const error = new Error("whatever");
    error.name = "JsoncSyntaxError";
    expect(errorMessage(error)).toBe("配置文件存在 JSONC 语法错误（1 处），请先修复后再试");
  });
});

describe("errorMessage — errno mapping", () => {
  function errnoError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: nope`, { cause: undefined }), {
      code,
      errno: -1,
      syscall: "open",
      path: "/x",
    });
  }

  it("maps EACCES and EPERM to a permission message carrying the code", () => {
    expect(errorMessage(errnoError("EACCES"))).toBe("没有权限访问文件或目录（EACCES）");
    expect(errorMessage(errnoError("EPERM"))).toBe("没有权限访问文件或目录（EPERM）");
  });

  it("maps EBUSY / ENOSPC / ENOENT / ENAMETOOLONG", () => {
    expect(errorMessage(errnoError("EBUSY"))).toBe("文件被其他程序占用（EBUSY）");
    expect(errorMessage(errnoError("ENOSPC"))).toBe("磁盘空间不足（ENOSPC）");
    expect(errorMessage(errnoError("ENOENT"))).toBe("文件不存在（ENOENT）");
    expect(errorMessage(errnoError("ENAMETOOLONG"))).toBe("文件名过长（ENAMETOOLONG）");
  });

  it("maps other errno codes to the generic filesystem failure with the code", () => {
    expect(errorMessage(errnoError("EXDEV"))).toBe("文件系统操作失败（EXDEV）");
  });

  it("ignores non-string numeric legacy codes (DOMException.code)", () => {
    const error = new Error("boom");
    (error as unknown as { code: number }).code = 8;
    expect(errorMessage(error)).toBe("boom");
  });
});

describe("errorDetail — log-oriented friendly + raw detail", () => {
  it("appends the raw detail after the friendly message", () => {
    expect(errorDetail(new Error("PRESET_NOT_FOUND"))).toBe("模板不存在（原始信息: PRESET_NOT_FOUND）");
  });

  it("keeps the errno original (carrying the failing path) that errorMessage drops", () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/x/opencode.json'"), {
      code: "EACCES",
    });
    expect(errorDetail(error)).toBe(
      "没有权限访问文件或目录（EACCES）（原始信息: EACCES: permission denied, open '/x/opencode.json'）",
    );
  });

  it("includes the JsoncSyntaxError count and the raw message", () => {
    const error = new JsoncSyntaxError([{ offset: 1, length: 1, message: "语法错误（错误码 1）" }]);
    expect(errorDetail(error)).toBe(
      "配置文件存在 JSONC 语法错误（1 处），请先修复后再试（原始信息: JSONC syntax errors: 1）",
    );
  });

  it("omits the suffix when the raw message IS the friendly message (no duplication)", () => {
    expect(errorDetail(new Error("boom"))).toBe("boom");
  });

  it("never throws and mirrors errorMessage for non-Error inputs", () => {
    expect(errorDetail("plain")).toBe("plain");
    expect(errorDetail(42)).toBe("42");
    expect(() => errorDetail({})).not.toThrow();
  });
});

describe("errorMessage — fallback and totality", () => {
  it("returns the raw message for unmatched Errors", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error inputs", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("never throws, even for exotic inputs", () => {
    expect(() => errorMessage({})).not.toThrow();
    expect(() => errorMessage(() => "fn")).not.toThrow();
  });
});
