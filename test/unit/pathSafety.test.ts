import { describe, expect, it } from "vitest";
import { assertContainedFileName, PRESET_NAME_PATTERN, presetNameError } from "../../src/core/pathSafety";

describe("assertContainedFileName (traversal guard)", () => {
  it("accepts plain names", () => {
    expect(() => assertContainedFileName("2026-08-22T10-00-00-000Z-manual", "ERR")).not.toThrow();
    expect(() => assertContainedFileName("我的 模板.json", "ERR")).not.toThrow();
  });

  it.each(["", ".", "..", "../evil", "a/b", "a\0b", "/abs/path"])(
    "rejects %j",
    (name) => {
      expect(() => assertContainedFileName(name, "ERR")).toThrow("ERR");
    },
  );

  it("rejects backslash and win32-absolute forms only on win32 (legal POSIX filenames stay manageable)", () => {
    expect(() => assertContainedFileName("a\\b", "ERR", "win32")).toThrow("ERR");
    expect(() => assertContainedFileName("C:\\win\\abs", "ERR", "win32")).toThrow("ERR");
    expect(() => assertContainedFileName("a\\b", "ERR", "linux")).not.toThrow();
    expect(() => assertContainedFileName("a\\b", "ERR", "darwin")).not.toThrow();
  });
});

describe("PRESET_NAME_PATTERN / presetNameError (portable file names)", () => {
  it("accepts portable names including spaces, CJK and dots", () => {
    for (const name of ["重度创作", "my preset", "v2.final", "a".repeat(64)]) {
      expect(PRESET_NAME_PATTERN.test(name)).toBe(true);
      expect(presetNameError(name)).toBeUndefined();
    }
  });

  it.each(["a/b", "a\\b", "a:b", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "", "x".repeat(65)])(
    "rejects forbidden char/length %j",
    (name) => {
      expect(presetNameError(name)).toBeDefined();
    },
  );

  it("rejects control characters", () => {
    expect(presetNameError(`a${String.fromCharCode(0)}b`)).toBeDefined();
    expect(presetNameError(`a${String.fromCharCode(31)}b`)).toBeDefined();
  });

  it("rejects trailing dot/space (silently stripped on Windows)", () => {
    expect(presetNameError("name.")).toBeDefined();
    expect(presetNameError("name ")).toBeDefined();
  });

  it("rejects DOS reserved names, case-insensitive, with or without extension", () => {
    for (const name of ["CON", "con", "Prn", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "con.txt"]) {
      expect(presetNameError(name)).toBeDefined();
    }
    expect(presetNameError("console")).toBeUndefined();
    expect(presetNameError("COM10")).toBeUndefined();
  });
});
