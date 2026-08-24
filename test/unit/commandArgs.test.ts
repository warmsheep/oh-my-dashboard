import { describe, expect, it } from "vitest";

import { presetNameError } from "../../src/constants";
import type { BackupEntry } from "../../src/core/types";
import { VARIANTS } from "../../src/core/types";
import {
  agentModelRequestFromArg,
  agentTargetFromArg,
  backupEntryFromArg,
  exportBackupRequestFromArg,
  exportPresetRequestFromArg,
  isAllowedExportTarget,
  presetNameFromArg,
  renameBackupRequestFromArg,
  renamePresetRequestFromArg,
} from "../../src/ui/commandArgs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
const TMP = process.platform === "win32" ? "C:\\Temp" : "/tmp";
const WS = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
const sep = process.platform === "win32" ? "\\" : "/";

function makeBackup(dirName: string, dir = `${WS}/backups/${dirName}`): BackupEntry {
  return {
    dirName,
    dir,
    manifest: {
      version: 1,
      reason: "manual",
      createdAt: "2026-08-24T00:00:00.000Z",
      fileCount: 1,
      machine: "e2e-host",
    },
  };
}

// ---------------------------------------------------------------------------
// agentModelRequestFromArg — setAgentModel programmatic contract (B3 table)
// ---------------------------------------------------------------------------

describe("agentModelRequestFromArg", () => {
  it("returns undefined for args without programmatic intent", () => {
    expect(agentModelRequestFromArg(undefined)).toBeUndefined();
    expect(agentModelRequestFromArg(null)).toBeUndefined();
    expect(agentModelRequestFromArg("build")).toBeUndefined();
    expect(agentModelRequestFromArg([])).toBeUndefined();
    // Tree node arg: key set never overlaps {section,name,model,variant}.
    expect(agentModelRequestFromArg({ kind: "agent", id: "agent:build", label: "build" })).toBeUndefined();
  });

  it("accepts a valid request and defaults variant to null", () => {
    expect(agentModelRequestFromArg({ section: "agents", name: "build", model: "prov/model" })).toEqual({
      section: "agents",
      name: "build",
      model: "prov/model",
      variant: null,
    });
  });

  it("keeps an explicit variant and accepts null", () => {
    expect(agentModelRequestFromArg({ section: "categories", name: "writing", model: "p/m", variant: "high" })).toEqual(
      { section: "categories", name: "writing", model: "p/m", variant: "high" },
    );
    expect(agentModelRequestFromArg({ section: "agents", name: "build", model: "p/m", variant: null })).toEqual({
      section: "agents",
      name: "build",
      model: "p/m",
      variant: null,
    });
  });

  it("treats either key as intent and rejects present-but-invalid shapes in Chinese", () => {
    // `name` alone carries no intent (section/model are the intent keys, exactly as
    // the B3 contract defines — tree nodes never carry section/model/name).
    expect(agentModelRequestFromArg({ name: "build" })).toBeUndefined();
    expect(agentModelRequestFromArg({ model: "p/m" })).toEqual({ error: "参数 section 必须是 agents 或 categories" });
    expect(agentModelRequestFromArg({ section: "agents", model: "p/m" })).toEqual({
      error: "参数 name 必须是非空字符串",
    });
    expect(agentModelRequestFromArg({ section: "agents", name: "", model: "p/m" })).toEqual({
      error: "参数 name 必须是非空字符串",
    });
    expect(agentModelRequestFromArg({ section: "agents", name: "build", model: "no-slash" })).toEqual({
      error: "参数 model 必须是 provider/model 格式的模型 ID",
    });
    expect(agentModelRequestFromArg({ section: "agents", name: "build", model: "p/m", variant: "ultra" })).toEqual({
      error: `参数 variant 必须是 ${VARIANTS.join(" / ")} 之一或 null`,
    });
  });
});

// ---------------------------------------------------------------------------
// renamePresetRequestFromArg — { from, to } contract
// ---------------------------------------------------------------------------

describe("renamePresetRequestFromArg", () => {
  it("returns undefined without intent", () => {
    expect(renamePresetRequestFromArg(undefined)).toBeUndefined();
    expect(renamePresetRequestFromArg("e2e-preset")).toBeUndefined();
    expect(renamePresetRequestFromArg({ kind: "preset", id: "preset:a", label: "a" })).toBeUndefined();
  });

  it("either key is intent; partial shapes error instead of falling back", () => {
    expect(renamePresetRequestFromArg({ from: "a" })).toEqual({
      error: "参数须为 { from: 非空字符串, to: 字符串 }",
    });
    expect(renamePresetRequestFromArg({ to: "b" })).toEqual({
      error: "参数须为 { from: 非空字符串, to: 字符串 }",
    });
    expect(renamePresetRequestFromArg({ from: "", to: "b" })).toEqual({
      error: "参数须为 { from: 非空字符串, to: 字符串 }",
    });
  });

  it("accepts a valid pair and rejects an invalid target name via presetNameError", () => {
    expect(renamePresetRequestFromArg({ from: "a", to: "b" })).toEqual({ from: "a", to: "b" });
    const invalid = renamePresetRequestFromArg({ from: "a", to: "../evil" });
    expect(invalid).toEqual({ error: presetNameError("../evil") });
  });
});

// ---------------------------------------------------------------------------
// renameBackupRequestFromArg — { dirName, name } contract
// ---------------------------------------------------------------------------

describe("renameBackupRequestFromArg", () => {
  it("returns undefined without intent", () => {
    expect(renameBackupRequestFromArg(undefined)).toBeUndefined();
    expect(renameBackupRequestFromArg("2026-manual")).toBeUndefined();
    expect(renameBackupRequestFromArg({ kind: "backup", id: "backup:x", label: "x" })).toBeUndefined();
  });

  it("either key is intent; partial or blank shapes error in Chinese", () => {
    expect(renameBackupRequestFromArg({ dirName: "x" })).toEqual({
      error: "参数须为 { dirName: 非空字符串, name: 字符串 }",
    });
    expect(renameBackupRequestFromArg({ name: "y" })).toEqual({
      error: "参数须为 { dirName: 非空字符串, name: 字符串 }",
    });
    expect(renameBackupRequestFromArg({ dirName: "", name: "y" })).toEqual({
      error: "参数须为 { dirName: 非空字符串, name: 字符串 }",
    });
    expect(renameBackupRequestFromArg({ dirName: "x", name: "   " })).toEqual({ error: "名称不能为空" });
  });

  it("accepts a valid request and trims the display name", () => {
    expect(renameBackupRequestFromArg({ dirName: "x", name: " y " })).toEqual({ dirName: "x", name: "y" });
  });
});

// ---------------------------------------------------------------------------
// exportPresetRequestFromArg / exportBackupRequestFromArg — export contracts
// ---------------------------------------------------------------------------

describe("exportPresetRequestFromArg", () => {
  it("returns undefined without intent", () => {
    expect(exportPresetRequestFromArg(undefined)).toBeUndefined();
    expect(exportPresetRequestFromArg("e2e-preset")).toBeUndefined();
    expect(exportPresetRequestFromArg({ kind: "preset", id: "preset:a", label: "a" })).toBeUndefined();
  });

  it("either key is intent; partial shapes error in Chinese", () => {
    expect(exportPresetRequestFromArg({ name: "a" })).toEqual({
      error: "参数须为 { name: 非空字符串, target: 导出文件路径 }",
    });
    expect(exportPresetRequestFromArg({ target: `${TMP}/a.json` })).toEqual({
      error: "参数须为 { name: 非空字符串, target: 导出文件路径 }",
    });
    expect(exportPresetRequestFromArg({ name: "", target: `${TMP}/a.json` })).toEqual({
      error: "参数须为 { name: 非空字符串, target: 导出文件路径 }",
    });
    expect(exportPresetRequestFromArg({ name: "a", target: "" })).toEqual({
      error: "参数须为 { name: 非空字符串, target: 导出文件路径 }",
    });
  });

  it("accepts a valid request", () => {
    expect(exportPresetRequestFromArg({ name: "a", target: `${TMP}/a.json` })).toEqual({
      name: "a",
      target: `${TMP}/a.json`,
    });
  });
});

describe("exportBackupRequestFromArg", () => {
  it("returns undefined without intent (tree nodes never carry dirName/target)", () => {
    expect(exportBackupRequestFromArg(undefined)).toBeUndefined();
    expect(exportBackupRequestFromArg("2026-manual")).toBeUndefined();
    expect(exportBackupRequestFromArg({ kind: "backup", id: "backup:x", label: "x", filePath: "/b" })).toBeUndefined();
  });

  it("either key is intent — partial shapes error instead of reaching the save dialog", () => {
    // Aligned with the other programmatic commands: a present-but-invalid arg must
    // never silently fall back to the interactive (modal) path.
    expect(exportBackupRequestFromArg({ dirName: "x" })).toEqual({
      error: "参数须为 { dirName: 非空字符串, target: 导出文件路径 }",
    });
    expect(exportBackupRequestFromArg({ target: `${TMP}/x.zip` })).toEqual({
      error: "参数须为 { dirName: 非空字符串, target: 导出文件路径 }",
    });
    expect(exportBackupRequestFromArg({ dirName: "", target: `${TMP}/x.zip` })).toEqual({
      error: "参数须为 { dirName: 非空字符串, target: 导出文件路径 }",
    });
    expect(exportBackupRequestFromArg({ dirName: "x", target: "" })).toEqual({
      error: "参数须为 { dirName: 非空字符串, target: 导出文件路径 }",
    });
  });

  it("accepts a valid request", () => {
    expect(exportBackupRequestFromArg({ dirName: "x", target: `${TMP}/x.zip` })).toEqual({
      dirName: "x",
      target: `${TMP}/x.zip`,
    });
  });
});

// ---------------------------------------------------------------------------
// Tree-node arg decoders (NodeLike family)
// ---------------------------------------------------------------------------

describe("presetNameFromArg", () => {
  it("reads the name from a plain string, a preset label, or a preset id suffix", () => {
    expect(presetNameFromArg("e2e-preset")).toBe("e2e-preset");
    expect(presetNameFromArg({ kind: "preset", id: "preset:abc", label: "显示名" })).toBe("显示名");
    expect(presetNameFromArg({ kind: "preset", id: "preset:abc" })).toBe("abc");
  });

  it("returns undefined for foreign node kinds and junk", () => {
    expect(presetNameFromArg(undefined)).toBeUndefined();
    expect(presetNameFromArg({ kind: "file", id: "file:x", label: "x" })).toBeUndefined();
    expect(presetNameFromArg({ label: "x" })).toBe("x"); // kind-less node falls back to label
    expect(presetNameFromArg({ kind: "preset" })).toBeUndefined(); // no label, no id
  });
});

describe("agentTargetFromArg", () => {
  it("resolves agents vs categories from kind or id prefix", () => {
    expect(agentTargetFromArg({ kind: "agent", id: "agent:build", label: "build" })).toEqual({
      section: "agents",
      name: "build",
    });
    expect(agentTargetFromArg({ kind: "category", id: "category:writing" })).toEqual({
      section: "categories",
      name: "writing",
    });
  });

  it("returns undefined for anything else", () => {
    expect(agentTargetFromArg(undefined)).toBeUndefined();
    expect(agentTargetFromArg({ kind: "preset", id: "preset:a" })).toBeUndefined();
    expect(agentTargetFromArg({ id: "agent:" })).toBeUndefined(); // empty name suffix
  });
});

describe("backupEntryFromArg", () => {
  const entries = [makeBackup("b-old"), makeBackup("b-new")];

  it("matches by dirName string, id suffix, dir path, or dir basename", () => {
    expect(backupEntryFromArg("b-new", entries)?.dirName).toBe("b-new");
    expect(backupEntryFromArg({ kind: "backup", id: "backup:b-old" }, entries)?.dirName).toBe("b-old");
    expect(backupEntryFromArg({ filePath: `${WS}/backups/b-new` }, entries)?.dirName).toBe("b-new");
    expect(backupEntryFromArg({ filePath: "b-old" }, entries)?.dirName).toBe("b-old");
  });

  it("returns undefined when nothing matches", () => {
    expect(backupEntryFromArg("missing", entries)).toBeUndefined();
    expect(backupEntryFromArg(undefined, entries)).toBeUndefined();
    expect(backupEntryFromArg({ filePath: `${TMP}/unrelated` }, entries)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isAllowedExportTarget — path guard for programmatic write/open targets
// ---------------------------------------------------------------------------

describe("isAllowedExportTarget", () => {
  const roots = [HOME, TMP, WS];

  it("allows targets inside any root (home / tmp / workspace)", () => {
    expect(isAllowedExportTarget(`${HOME}${sep}out${sep}preset.json`, roots)).toBe(true);
    expect(isAllowedExportTarget(`${TMP}${sep}ocm-e2e.zip`, roots)).toBe(true);
    expect(isAllowedExportTarget(`${WS}${sep}presets${sep}a.json`, roots)).toBe(true);
  });

  it("blocks system paths outside every root", () => {
    const etc = process.platform === "win32" ? "C:\\Windows\\system32\\evil.zip" : "/etc/passwd";
    expect(isAllowedExportTarget(etc, roots)).toBe(false);
    expect(isAllowedExportTarget(`/srv${sep}data${sep}x.zip`, roots)).toBe(false);
  });

  it("blocks sibling-directory prefix tricks (/home/u2 must not match /home/u)", () => {
    expect(isAllowedExportTarget(`${HOME}2${sep}x.zip`, roots)).toBe(false);
  });

  it("blocks traversal segments by resolving before the containment check", () => {
    expect(isAllowedExportTarget(`${TMP}${sep}x${sep}..${sep}..${sep}etc${sep}evil`, roots)).toBe(false);
    expect(isAllowedExportTarget(`${WS}${sep}..${sep}..${sep}etc${sep}evil.json`, roots)).toBe(false);
    // A traversal that stays INSIDE a root is still fine.
    expect(isAllowedExportTarget(`${TMP}${sep}a${sep}..${sep}b.zip`, roots)).toBe(true);
  });

  it("handles roots with trailing separators and empty root lists", () => {
    expect(isAllowedExportTarget(`${HOME}${sep}x.json`, [`${HOME}${sep}`])).toBe(true);
    expect(isAllowedExportTarget(`${HOME}${sep}x.json`, [])).toBe(false);
  });
});
