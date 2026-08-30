import type {
  McpServersValue,
  ModelCatalogValue,
  OpencodePermissionState,
  OpencodeSettingField,
  PermissionToolsValue,
  ShallowObjectValue,
} from "@shared/protocol";

/**
 * Pure helpers behind the controls/ composite editors (stringList / enumChips /
 * shallowObject / modelCatalog / permissionTools / mcpServers kinds). Bound mirrors
 * of the core validators: core keeps its constants private (node-side module), so the
 * numeric values here MUST stay in sync with the STRING_LIST_* constants of
 * src/core/opencodeSettings.ts and the MODEL_ALIAS_* / MODEL_CATALOG_* constants of
 * src/core/omoSettings.ts.
 */

// Mirror of core STRING_LIST_MAX_ENTRIES / STRING_LIST_ENTRY_MAX_LENGTH (opencodeSettings.ts).
const STRING_LIST_MAX_ENTRIES = 16;
const STRING_LIST_ENTRY_MAX_LENGTH = 256;
// Mirror of core ORDERED_LIST_MAX_ENTRIES / ORDERED_LIST_ENTRY_MAX_LENGTH (opencodeSettings.ts).
const ORDERED_LIST_MAX_ENTRIES = 64;
const ORDERED_LIST_ENTRY_MAX_LENGTH = 64;
// Mirror of core MODEL_CATALOG_MAX_ENTRIES / MODEL_ALIAS_MAX_LENGTH / MODEL_ALIAS_PATTERN (omoSettings.ts).
const MODEL_CATALOG_MAX_ENTRIES = 32;
const MODEL_ALIAS_MAX_LENGTH = 32;
const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Permission action literals (structural mirror of PermissionToolsValue's value union). */
export type PermissionAction = "allow" | "ask" | "deny";

// ---------------------------------------------------------------------------
// stringList + orderedList kinds
// ---------------------------------------------------------------------------

/** Result of a list-kind add-row commit: commit posts, invalid keeps the draft + shows the red hint. */
export type ListEntryParse = { kind: "commit"; value: string } | { kind: "invalid"; error: string };

/**
 * Shared add-row validation of the list kinds: trimmed non-empty, ≤maxEntryLength
 * chars, unique, and the list stays ≤maxEntries — the same rules core's
 * isValidUniqueStringEntries enforces on the write path (stringList and
 * orderedList differ ONLY in these bounds).
 */
function parseUniqueListEntry(
  raw: string,
  current: readonly string[],
  maxEntries: number,
  maxEntryLength: number,
): ListEntryParse {
  const text = raw.trim();
  if (text === "") {
    return { kind: "invalid", error: "条目不能为空" };
  }
  if (text.length > maxEntryLength) {
    return { kind: "invalid", error: `最长 ${maxEntryLength} 个字符` };
  }
  if (current.includes(text)) {
    return { kind: "invalid", error: "该条目已存在" };
  }
  if (current.length >= maxEntries) {
    return { kind: "invalid", error: `最多 ${maxEntries} 条` };
  }
  return { kind: "commit", value: text };
}

/** stringList add-row validation (≤16 entries of ≤256 chars — core's STRING_LIST_* bounds). */
export function parseStringListEntry(raw: string, current: readonly string[]): ListEntryParse {
  return parseUniqueListEntry(raw, current, STRING_LIST_MAX_ENTRIES, STRING_LIST_ENTRY_MAX_LENGTH);
}

/** orderedList add-row validation (≤64 entries of ≤64 chars — core's ORDERED_LIST_* bounds). */
export function parseOrderedListEntry(raw: string, current: readonly string[]): ListEntryParse {
  return parseUniqueListEntry(raw, current, ORDERED_LIST_MAX_ENTRIES, ORDERED_LIST_ENTRY_MAX_LENGTH);
}

/** Remove one entry by index; an empty result becomes null (remove the whole key). */
export function removeListEntry(current: readonly string[], index: number): string[] | null {
  const next = current.filter((_, i) => i !== index);
  return next.length === 0 ? null : next;
}

/**
 * Move one entry by one slot (delta -1 = up, +1 = down); edge and out-of-range
 * moves return the list unchanged (the ↑/↓ buttons are disabled at the edges —
 * defensive only).
 */
export function moveListEntry(current: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= current.length || target < 0 || target >= current.length) {
    return [...current];
  }
  const next = [...current];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry);
  return next;
}

// ---------------------------------------------------------------------------
// enumChips kind
// ---------------------------------------------------------------------------

/**
 * Next checked set after one chip toggles; the caller posts the result directly
 * (null = empty selection → remove the key). Shared by the OpenCode providers
 * chips semantics and the OMO enumChips kind.
 */
export function toggleChipValue(current: readonly string[], option: string, checked: boolean): string[] | null {
  if (!checked) {
    const next = current.filter((name) => name !== option);
    return next.length === 0 ? null : next;
  }
  return current.includes(option) ? [...current] : [...current, option];
}

// ---------------------------------------------------------------------------
// shallowObject / number kinds
// ---------------------------------------------------------------------------

/** Inclusive numeric bounds shared by shallowObject fields and the OpenCode number kind. */
export interface NumberFieldBounds {
  min?: number;
  max?: number;
  /** Reject non-integers when true; decimals allowed exactly when this is not set. */
  integer?: boolean;
}

/** Anything carrying the numeric bounds (OpencodeSettingField, OpencodeSetting, OmoMiscSetting). */
export type NumberBoundsSource = NumberFieldBounds;

/**
 * Result of parsing a number-field commit: "commit" posts the value (null = empty →
 * field 未设置), "noop" keeps the state unchanged and posts nothing (non-numeric
 * text), "invalid" keeps the raw draft and shows the Chinese bounds error.
 */
export type NumberFieldParse =
  { kind: "commit"; value: number | null } | { kind: "noop" } | { kind: "invalid"; error: string };

/** Chinese bounds error for a rejected number (integer vs decimal wording, one-sided bounds). */
function numberBoundsError(bounds: NumberFieldBounds): string {
  const noun = bounds.integer === true ? "整数" : "数值";
  if (bounds.min !== undefined && bounds.max !== undefined) {
    return `需为 ${bounds.min}–${bounds.max} 的${noun}`;
  }
  if (bounds.min !== undefined) {
    return `需为不小于 ${bounds.min} 的${noun}`;
  }
  if (bounds.max !== undefined) {
    return `需为不大于 ${bounds.max} 的${noun}`;
  }
  return `需为${noun}`;
}

/**
 * Parse a number-field commit: empty → null (未设置); non-numeric → noop (keep the
 * draft); decimals rejected exactly when integer === true; values outside the
 * inclusive bounds are invalid with the Chinese error — the same rules core's
 * isValidShallowObjectLeaf / isValidOpencodeSettingValue(number) enforce.
 */
export function parseNumberFieldInput(raw: string, bounds: NumberBoundsSource): NumberFieldParse {
  const text = raw.trim();
  if (text === "") {
    return { kind: "commit", value: null };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { kind: "noop" };
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    return { kind: "invalid", error: numberBoundsError(bounds) };
  }
  if ((bounds.min !== undefined && value < bounds.min) || (bounds.max !== undefined && value > bounds.max)) {
    return { kind: "invalid", error: numberBoundsError(bounds) };
  }
  return { kind: "commit", value };
}

/** Effective boolean a shallow field switch shows: file leaf ?? field default ?? false. */
export function effectiveShallowBoolean(value: ShallowObjectValue | null, field: OpencodeSettingField): boolean {
  const leaf = value?.[field.key];
  if (leaf === true || leaf === false) {
    return leaf;
  }
  return field.default === true;
}

// ---------------------------------------------------------------------------
// modelCatalog kind
// ---------------------------------------------------------------------------

/** Chinese error for an invalid add-row alias, or null when the alias is acceptable. */
export function modelAliasError(raw: string, existingAliases: readonly string[]): string | null {
  const text = raw.trim();
  if (text === "") {
    return "别名不能为空";
  }
  if (text.length > MODEL_ALIAS_MAX_LENGTH) {
    return `最长 ${MODEL_ALIAS_MAX_LENGTH} 个字符`;
  }
  if (!MODEL_ALIAS_PATTERN.test(text)) {
    return "仅限字母、数字与 . _ -";
  }
  if (existingAliases.includes(text)) {
    return "别名已存在";
  }
  if (existingAliases.length >= MODEL_CATALOG_MAX_ENTRIES) {
    return `最多 ${MODEL_CATALOG_MAX_ENTRIES} 条别名`;
  }
  return null;
}

/** Count of live (non-null) entries — null entries are deletion markers only. */
function catalogLiveCount(catalog: ModelCatalogValue): number {
  return Object.values(catalog).filter((entry) => entry !== null).length;
}

/** Upsert one alias entry into the snapshot (aggregated full-catalog commit semantics). */
export function withCatalogEntry(
  catalog: ModelCatalogValue | null,
  alias: string,
  entry: { model: string; reasoning: string | null },
): ModelCatalogValue {
  return { ...(catalog ?? {}), [alias]: entry };
}

/**
 * Delete one alias: a file-existing entry becomes a null deletion marker (the host
 * removes just that alias key); when no live entry remains the whole snapshot
 * collapses to null (remove the models key).
 */
export function withoutCatalogAlias(catalog: ModelCatalogValue | null, alias: string): ModelCatalogValue | null {
  const next: ModelCatalogValue = { ...(catalog ?? {}) };
  if (next[alias] !== undefined && next[alias] !== null) {
    next[alias] = null;
  } else {
    delete next[alias];
  }
  return catalogLiveCount(next) === 0 ? null : next;
}

// ---------------------------------------------------------------------------
// shared layout helper
// ---------------------------------------------------------------------------

/** Kinds whose control spans the full set-row width (set-row-wrap layout in both tabs). */
const WIDE_KINDS: ReadonlySet<string> = new Set([
  "providers",
  "stringList",
  "orderedList",
  "enumChips",
  "shallowObject",
  "permissionTools",
  "mcpServers",
  "modelCatalog",
]);

/** True when the descriptor's control needs the wrapping full-width set-row layout. */
export function isWideSettingKind(kind: string): boolean {
  return WIDE_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// permissionTools kind
// ---------------------------------------------------------------------------

/**
 * Single-key edit map for one tool row: the host applies per-key edits for keys
 * PRESENT in the value (null removes that tool's permission key), so every tool-row
 * commit sends exactly { tool: action | null } — never a full tools snapshot.
 */
export function permissionToolEdit(tool: string, action: PermissionAction | null): PermissionToolsValue {
  return { [tool]: action };
}

/** True when the permission key is object-form with content — the shorthand select must stay read-only (已按工具设置). */
export function isPermissionShorthandLocked(state: OpencodePermissionState): boolean {
  return state.shorthand === null && (Object.keys(state.tools).length > 0 || state.advancedTools.length > 0);
}

/** True when the permission key is string-form — every tool row is disabled (已设全局简写). */
export function isPermissionToolsLocked(state: OpencodePermissionState): boolean {
  return state.shorthand !== null;
}

// ---------------------------------------------------------------------------
// mcpServers kind
// ---------------------------------------------------------------------------

/**
 * Single-key snapshot map for one server toggle (same per-key semantics as
 * permissionToolEdit): true → the host sets mcp.<name>.enabled=false, false → the
 * host removes the enabled override. null is never sent (the mcp key is never wiped).
 */
export function mcpToggleEdit(name: string, disabled: boolean): McpServersValue {
  return { [name]: disabled };
}
