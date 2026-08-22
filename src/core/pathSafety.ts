import * as path from "node:path";

/**
 * Cross-platform filename safety.
 *
 * Two tiers:
 * - assertContainedFileName: traversal guard for names that resolve inside a known
 *   directory (backup dirNames, preset names on load/remove). Rejects separators,
 *   "..", absolute paths and NUL so a programmatic command arg can never escape
 *   its parent dir. Intentionally lax otherwise — existing files created with
 *   looser rules must stay loadable/removable on every OS.
 * - presetNameError: strict validation for names that will CREATE a file. Portable
 *   across NTFS/APFS/ext4: no Windows-forbidden chars (<>:"|?*, control chars),
 *   no trailing dot/space (silently stripped by Windows), no DOS reserved names.
 */

export function assertContainedFileName(
  name: string,
  errorCode: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // "/" is a separator everywhere; "\" only on win32 — a POSIX file legitimately named
  // "a\b" must stay manageable (load/remove/restore), it just can't traverse anywhere.
  const hasSeparator = name.includes("/") || (platform === "win32" && name.includes("\\"));
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    hasSeparator ||
    name.includes("\0") ||
    path.isAbsolute(name)
  ) {
    throw new Error(errorCode);
  }
}

/** 1–64 chars, no path separators, no Windows-forbidden or control characters. */
export const PRESET_NAME_PATTERN = /^[^/\\<>:"|?*\x00-\x1f]{1,64}$/;

/** DOS device names are illegal file names on Windows even with an extension (CON.txt). */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Returns an error message when `name` cannot become a portable file name, else undefined. */
export function presetNameError(name: string): string | undefined {
  if (!PRESET_NAME_PATTERN.test(name)) {
    return '名称须为 1-64 个字符，且不含 / \\ < > : " | ? * 或控制字符';
  }
  if (name.endsWith(".") || name.endsWith(" ")) {
    return "名称不能以点或空格结尾（Windows 不兼容）";
  }
  if (WINDOWS_RESERVED_NAME.test(name.split(".")[0])) {
    return "名称不能使用 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）";
  }
  return undefined;
}
