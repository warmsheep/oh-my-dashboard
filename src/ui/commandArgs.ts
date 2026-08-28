import * as path from "node:path";

import { MODEL_ID_PATTERN, presetNameError } from "../constants";
import type { BackupEntry, BackupScope } from "../core/types";
import { BACKUP_SCOPES, VARIANTS } from "../core/types";

/**
 * Pure, vscode-free decoding/validation of command arguments (tree nodes passed by
 * VSCode, programmatic object forms used by e2e/scripts). Extracted from commands.ts
 * so the contracts are unit-testable without an extension host.
 *
 * Programmatic-arg convention (all request decoders below): ANY of the distinctive
 * keys appearing as a string marks programmatic intent — the decoder then strictly
 * validates and returns `{ error }` for present-but-invalid shapes. Callers must
 * show the Chinese error and never fall back to an interactive picker/dialog
 * (headless runs would hang on the modal).
 */

/** The five scalar fields a tree node's command argument carries (see provider.getTreeItem). */
export interface NodeLike {
  kind?: string;
  id?: string;
  label?: string;
  description?: string;
  filePath?: string;
}

/** Agent or category addressed by a tree node / programmatic arg. */
export interface AgentTarget {
  section: "agents" | "categories";
  name: string;
}

/** Narrow an unknown command arg to the NodeLike shape; non-objects yield undefined. */
export function toNode(arg: unknown): NodeLike | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const n = arg as Record<string, unknown>;
  return {
    kind: typeof n.kind === "string" ? n.kind : undefined,
    id: typeof n.id === "string" ? n.id : undefined,
    label: typeof n.label === "string" ? n.label : undefined,
    description: typeof n.description === "string" ? n.description : undefined,
    filePath: typeof n.filePath === "string" ? n.filePath : undefined,
  };
}

/** Text after the first ":" of a node id (`agent:build` → `build`), else undefined. */
export function idSuffix(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  const idx = id.indexOf(":");
  return idx >= 0 ? id.slice(idx + 1) : undefined;
}

/** Preset name from a plain string arg, a preset node label, or its id suffix. */
export function presetNameFromArg(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.length > 0) {
    return arg;
  }
  const node = toNode(arg);
  if (!node || (node.kind !== undefined && node.kind !== "preset")) {
    return undefined;
  }
  return node.label ?? idSuffix(node.id);
}

/** Agent/category target from a tree node arg, else undefined. */
export function agentTargetFromArg(arg: unknown): AgentTarget | undefined {
  const node = toNode(arg);
  if (!node) {
    return undefined;
  }
  const isAgent = node.kind === "agent" || node.id?.startsWith("agent:");
  const isCategory = node.kind === "category" || node.id?.startsWith("category:");
  if (!isAgent && !isCategory) {
    return undefined;
  }
  const name = idSuffix(node.id) ?? node.label;
  if (!name) {
    return undefined;
  }
  return { section: isAgent ? "agents" : "categories", name };
}

/** Backup entry matching the arg (dirName string, node id suffix, dir path/basename), else undefined. */
export function backupEntryFromArg(arg: unknown, entries: readonly BackupEntry[]): BackupEntry | undefined {
  if (typeof arg === "string" && arg.length > 0) {
    return entries.find((entry) => entry.dirName === arg);
  }
  const node = toNode(arg);
  if (!node) {
    return undefined;
  }
  const candidate = idSuffix(node.id);
  if (candidate) {
    const hit = entries.find((entry) => entry.dirName === candidate);
    if (hit) {
      return hit;
    }
  }
  if (node.filePath) {
    const hit = entries.find(
      (entry) => entry.dir === node.filePath || entry.dirName === path.basename(node.filePath ?? ""),
    );
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** Validated programmatic setAgentModel request. */
export interface AgentModelRequest {
  section: "agents" | "categories";
  name: string;
  model: string;
  variant: string | null;
}

/**
 * Decode `{ section, name, model, variant? }`. Undefined when the arg carries no
 * programmatic intent (undefined, string, or a tree node — the key sets never
 * overlap), a validated request, or a Chinese error for present-but-invalid args.
 */
export function agentModelRequestFromArg(arg: unknown): AgentModelRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (o.section === undefined && o.model === undefined) {
    return undefined;
  }
  if (o.section !== "agents" && o.section !== "categories") {
    return { error: "参数 section 必须是 agents 或 categories" };
  }
  if (typeof o.name !== "string" || o.name.length === 0) {
    return { error: "参数 name 必须是非空字符串" };
  }
  if (typeof o.model !== "string" || !MODEL_ID_PATTERN.test(o.model)) {
    return { error: "参数 model 必须是 provider/model 格式的模型 ID" };
  }
  if (o.variant !== undefined && o.variant !== null) {
    if (typeof o.variant !== "string" || !(VARIANTS as readonly string[]).includes(o.variant)) {
      return { error: `参数 variant 必须是 ${VARIANTS.join(" / ")} 之一或 null` };
    }
  }
  return {
    section: o.section,
    name: o.name,
    model: o.model,
    variant: typeof o.variant === "string" ? o.variant : null,
  };
}

/** Validated programmatic renamePreset request (`to` already passed presetNameError). */
export interface RenamePresetRequest {
  from: string;
  to: string;
}

/** Decode `{ from, to }` — either string key marks intent; `to` must be a legal preset name. */
export function renamePresetRequestFromArg(arg: unknown): RenamePresetRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (typeof o.from !== "string" && typeof o.to !== "string") {
    return undefined;
  }
  if (typeof o.from !== "string" || o.from.length === 0 || typeof o.to !== "string") {
    return { error: "参数须为 { from: 非空字符串, to: 字符串 }" };
  }
  const nameError = presetNameError(o.to);
  if (nameError !== undefined) {
    return { error: nameError };
  }
  return { from: o.from, to: o.to };
}

/** Validated programmatic renameBackup request (display name trimmed, non-empty). */
export interface RenameBackupRequest {
  dirName: string;
  name: string;
}

/** Decode `{ dirName, name }` — either string key marks intent. */
export function renameBackupRequestFromArg(arg: unknown): RenameBackupRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (typeof o.dirName !== "string" && typeof o.name !== "string") {
    return undefined;
  }
  if (typeof o.dirName !== "string" || o.dirName.length === 0 || typeof o.name !== "string") {
    return { error: "参数须为 { dirName: 非空字符串, name: 字符串 }" };
  }
  const next = o.name.trim();
  if (next.length === 0) {
    return { error: "名称不能为空" };
  }
  return { dirName: o.dirName, name: next };
}

/** Shared scopes validation: non-empty array, every value a known BackupScope. */
function scopeListError(value: unknown): string | undefined {
  const known = BACKUP_SCOPES as readonly string[];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || !known.includes(v))) {
    return "scopes 须为 config/presets/models 的非空数组";
  }
  return undefined;
}

/** Validated programmatic backupNow request (name trimmed; scopes checked against BACKUP_SCOPES). */
export interface BackupNowRequest {
  name?: string;
  /** Omitted = all scopes (the command decides, not the parser). */
  scopes?: BackupScope[];
}

/** Decode `{ name?, scopes? }` — either key (own-property) marks intent. */
export function backupNowRequestFromArg(arg: unknown): BackupNowRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (!Object.hasOwn(o, "name") && !Object.hasOwn(o, "scopes")) {
    return undefined;
  }
  if (o.name !== undefined && typeof o.name !== "string") {
    return { error: "参数须为 { name?: 非空字符串, scopes?: config/presets/models 数组 }" };
  }
  const name = typeof o.name === "string" ? o.name.trim() : undefined;
  if (name !== undefined && name.length === 0) {
    return { error: "名称不能为空" };
  }
  if (Object.hasOwn(o, "scopes")) {
    const error = scopeListError(o.scopes);
    if (error !== undefined) {
      return { error };
    }
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(Array.isArray(o.scopes) ? { scopes: o.scopes as BackupScope[] } : {}),
  };
}

/** Validated programmatic restoreBackup request (scopes checked against BACKUP_SCOPES). */
export interface RestoreBackupRequest {
  dirName: string;
  /** Omitted = restore everything available; the command intersects with availability. */
  scopes?: BackupScope[];
}

/** Decode `{ dirName, scopes? }` — either key (own-property) marks intent. */
export function restoreBackupRequestFromArg(arg: unknown): RestoreBackupRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (!Object.hasOwn(o, "dirName") && !Object.hasOwn(o, "scopes")) {
    return undefined;
  }
  if (typeof o.dirName !== "string" || o.dirName.length === 0) {
    return { error: "参数须为 { dirName: 非空字符串, scopes?: config/presets/models 数组 }" };
  }
  if (Object.hasOwn(o, "scopes")) {
    const error = scopeListError(o.scopes);
    if (error !== undefined) {
      return { error };
    }
  }
  return {
    dirName: o.dirName,
    ...(Array.isArray(o.scopes) ? { scopes: o.scopes as BackupScope[] } : {}),
  };
}

/** Validated programmatic exportPreset request. */
export interface ExportPresetRequest {
  name: string;
  target: string;
}

/** Decode `{ name, target }` — either string key marks intent. */
export function exportPresetRequestFromArg(arg: unknown): ExportPresetRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (typeof o.name !== "string" && typeof o.target !== "string") {
    return undefined;
  }
  if (typeof o.name !== "string" || o.name.length === 0 || typeof o.target !== "string" || o.target.length === 0) {
    return { error: "参数须为 { name: 非空字符串, target: 导出文件路径 }" };
  }
  return { name: o.name, target: o.target };
}

/** Validated programmatic exportBackup request. */
export interface ExportBackupRequest {
  dirName: string;
  target: string;
}

/** Decode `{ dirName, target }` — either string key marks intent (both required when present). */
export function exportBackupRequestFromArg(arg: unknown): ExportBackupRequest | { error: string } | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const o = arg as Record<string, unknown>;
  if (typeof o.dirName !== "string" && typeof o.target !== "string") {
    return undefined;
  }
  if (
    typeof o.dirName !== "string" ||
    o.dirName.length === 0 ||
    typeof o.target !== "string" ||
    o.target.length === 0
  ) {
    return { error: "参数须为 { dirName: 非空字符串, target: 导出文件路径 }" };
  }
  return { dirName: o.dirName, target: o.target };
}

/**
 * Containment check for programmatic write/open targets: the resolved absolute path
 * must equal or live under one of the allowed roots (also resolved, so `..`
 * traversal is collapsed before the check and trailing separators are normalized).
 *
 * Lexical only — symlink escapes are NOT followed (same trust boundary as the rest
 * of the programmatic-arg surface; the guard exists to keep accidental/misrouted
 * command-bus invocations out of system paths, not to defend against local racers).
 */
export function isAllowedExportTarget(target: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
}
