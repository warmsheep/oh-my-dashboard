import type {
  AgentPairMapValue,
  AgentTextMapValue,
  ModelCatalogValue,
  NumberMapValue,
  OpencodePermissionState,
  OpencodeSettingField,
  PermissionToolsValue,
  RecordAggregate,
  RecordEditorValue,
  RecordEntryValue,
  RecordFieldDef,
  RecordFieldValue,
  ShallowObjectValue,
  StringMapValue,
} from "@shared/protocol";
import {
  AGENT_TEXT_MAX_LENGTH,
  OPENCODE_MULTILINE_VALUE_MAX_LENGTH,
  OPENCODE_STRING_VALUE_MAX_LENGTH,
} from "@shared/protocol";

/**
 * Pure helpers behind the controls/ composite editors (stringList / enumChips /
 * shallowObject / modelCatalog / permissionTools / recordEditor / recordMaster /
 * agentPairMap / agentTextMap kinds). Bound mirrors of the core validators: core
 * keeps its constants private (node-side module), so the numeric values here
 * MUST stay in sync with the STRING_LIST_* constants of src/core/opencodeSettings.ts
 * and the MODEL_ALIAS_* / MODEL_CATALOG_* constants of src/core/omoSettings.ts
 * (AGENT_TEXT_MAX_LENGTH is protocol-shared, so it is imported — no mirror).
 */

// Mirror of core STRING_LIST_MAX_ENTRIES / STRING_LIST_ENTRY_MAX_LENGTH (opencodeSettings.ts).
const STRING_LIST_MAX_ENTRIES = 16;
const STRING_LIST_ENTRY_MAX_LENGTH = 256;
// Mirror of core ORDERED_LIST_MAX_ENTRIES / ORDERED_LIST_ENTRY_MAX_LENGTH (opencodeSettings.ts).
const ORDERED_LIST_MAX_ENTRIES = 64;
const ORDERED_LIST_ENTRY_MAX_LENGTH = 64;
// Mirror of core PLUGIN_LIST_MAX_ENTRIES / PLUGIN_LIST_ENTRY_MAX_LENGTH / PLUGIN_LIST_ENTRY_PATTERN
// (opencodeSettings.ts) — the deliberately permissive npm-ish charset of the
// pluginList kind, incl. the ~/ ./ / file:// local path prefixes pluginResolver
// resolves (Windows drive-letter paths stay out; core comment has the note).
const PLUGIN_LIST_MAX_ENTRIES = 32;
const PLUGIN_LIST_ENTRY_MAX_LENGTH = 128;
const PLUGIN_LIST_ENTRY_PATTERN = /^[@A-Za-z0-9._\-/@+:~]+$/;
// Mirror of core MODEL_CATALOG_MAX_ENTRIES / MODEL_ALIAS_MAX_LENGTH / MODEL_ALIAS_PATTERN (omoSettings.ts).
const MODEL_CATALOG_MAX_ENTRIES = 32;
const MODEL_ALIAS_MAX_LENGTH = 32;
const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;
// Mirror of core NUMBER_MAP_MAX_ENTRIES (omoSettings.ts); exported for the numberMap add-row cap.
export const NUMBER_MAP_MAX_ENTRIES = 32;
// Mirror of core RECORD_NAME_* / RECORD_MAX_ENTRIES / RECORD_TEXT_* / RECORD_STRING_LIST_* (opencodeSettings.ts).
const RECORD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const RECORD_NAME_MAX_LENGTH = 64;
const RECORD_MAX_ENTRIES = 32;
const RECORD_TEXT_MAX_LENGTH = 256;
const RECORD_MULTILINE_MAX_LENGTH = 8000;
const RECORD_STRING_LIST_MAX_ENTRIES = 8;
// Mirror of core STRING_MAP_MAX_ENTRIES / STRING_MAP_KEY_MAX_LENGTH / STRING_MAP_VALUE_MAX_LENGTH
// (opencodeSettings.ts stringMap recordEditor field kind); the value bound is exported
// for the per-row value pre-check of StringMapEditor. (webview-ui cannot import src/core —
// only @shared/protocol is aliased into its bundle.)
const STRING_MAP_MAX_ENTRIES = 16;
const STRING_MAP_KEY_MAX_LENGTH = 128;
export const STRING_MAP_VALUE_MAX_LENGTH = 512;

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

/** stringList add-row validation (≤16 entries of ≤256 chars by default — recordEditor fields pass their own cap). */
export function parseStringListEntry(
  raw: string,
  current: readonly string[],
  maxEntries: number = STRING_LIST_MAX_ENTRIES,
): ListEntryParse {
  return parseUniqueListEntry(raw, current, maxEntries, STRING_LIST_ENTRY_MAX_LENGTH);
}

/** orderedList add-row validation (≤64 entries of ≤64 chars — core's ORDERED_LIST_* bounds). */
export function parseOrderedListEntry(raw: string, current: readonly string[]): ListEntryParse {
  return parseUniqueListEntry(raw, current, ORDERED_LIST_MAX_ENTRIES, ORDERED_LIST_ENTRY_MAX_LENGTH);
}

/** pluginList add-row validation (≤32 entries of ≤128 npm-ish chars — core's PLUGIN_LIST_* bounds + charset). */
export function parsePluginListEntry(raw: string, current: readonly string[]): ListEntryParse {
  const parsed = parseUniqueListEntry(raw, current, PLUGIN_LIST_MAX_ENTRIES, PLUGIN_LIST_ENTRY_MAX_LENGTH);
  if (parsed.kind === "commit" && !PLUGIN_LIST_ENTRY_PATTERN.test(parsed.value)) {
    return { kind: "invalid", error: "仅支持 npm 包名（可带 @版本）" };
  }
  return parsed;
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

/**
 * Chinese error for an invalid add-row key of the free-key maps, or null when the
 * key is acceptable: trimmed non-empty, identifier charset, ≤MODEL_ALIAS_MAX_LENGTH,
 * unique, and the entry cap when the caller passes a finite one (Infinity = no cap —
 * the identifier rules mirror core's isAllowedMapKey, which caps numberMap but not
 * free-key agentTextMap).
 */
export function identifierKeyError(
  raw: string,
  existingKeys: readonly string[],
  noun: string,
  maxEntries: number,
): string | null {
  const text = raw.trim();
  if (text === "") {
    return `${noun}不能为空`;
  }
  if (text.length > MODEL_ALIAS_MAX_LENGTH) {
    return `最长 ${MODEL_ALIAS_MAX_LENGTH} 个字符`;
  }
  if (!MODEL_ALIAS_PATTERN.test(text)) {
    return "仅限字母、数字与 . _ -";
  }
  if (existingKeys.includes(text)) {
    return `${noun}已存在`;
  }
  if (existingKeys.length >= maxEntries) {
    return `最多 ${maxEntries} 条${noun}`;
  }
  return null;
}

/** modelCatalog add-row alias validation — the 别名-flavored {@link identifierKeyError}. */
export function modelAliasError(raw: string, existingAliases: readonly string[]): string | null {
  return identifierKeyError(raw, existingAliases, "别名", MODEL_CATALOG_MAX_ENTRIES);
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
// shared commit parsers
// ---------------------------------------------------------------------------

/**
 * Shared commit parser behind the string-kind pre-checks: trim, empty → null
 * (remove the key), over the bound → invalid (keep the draft + Chinese error).
 */
export function parseBoundedStringInput(
  raw: string,
  maxLength: number,
): { kind: "commit"; value: string | null } | { kind: "invalid"; error: string } {
  const text = raw.trim();
  if (text === "") {
    return { kind: "commit", value: null };
  }
  if (text.length > maxLength) {
    return { kind: "invalid", error: `最长 ${maxLength} 个字符` };
  }
  return { kind: "commit", value: text };
}

/**
 * Parse a shallowObject string-leaf commit: the same rules with the field's
 * bound (field.maxLen ?? the protocol-shared OPENCODE_STRING_VALUE_MAX_LENGTH —
 * the exact default core's isValidShallowObjectLeaf applies, so the pre-check
 * can never drift from the host validator).
 */
export function parseShallowStringInput(
  raw: string,
  field: OpencodeSettingField,
): { kind: "commit"; value: string | null } | { kind: "invalid"; error: string } {
  return parseBoundedStringInput(raw, field.maxLen ?? OPENCODE_STRING_VALUE_MAX_LENGTH);
}

/**
 * Parse a shallowObject multiline-leaf commit (agent 系统提示词): the shared
 * bounded-string rules with the multiline bound (field.maxLen ?? the
 * protocol-shared OPENCODE_MULTILINE_VALUE_MAX_LENGTH — the exact default
 * core's isValidShallowObjectLeaf applies; protocol-shared constant, no mirror).
 */
export function parseShallowMultilineInput(
  raw: string,
  field: OpencodeSettingField,
): { kind: "commit"; value: string | null } | { kind: "invalid"; error: string } {
  return parseBoundedStringInput(raw, field.maxLen ?? OPENCODE_MULTILINE_VALUE_MAX_LENGTH);
}

/**
 * Single-field edit map of one shallowObject leaf commit (partial-commit rows —
 * shared-parent descriptors like the agent 扩展): the host applies per-leaf
 * edits for keys PRESENT in the value, so only the edited leaf is ever touched
 * and sibling leaves the read cannot surface (hand-written permission pattern
 * objects) are never collateral damage — same convention as permissionToolEdit.
 */
export function shallowLeafEdit(fieldKey: string, leaf: ShallowObjectValue[string]): ShallowObjectValue {
  return { [fieldKey]: leaf };
}

// ---------------------------------------------------------------------------
// stringMap field rows (recordEditor environment/headers)
// ---------------------------------------------------------------------------

/** Result of a stringMap add-row commit: commit posts, invalid keeps the draft + shows the red hint. */
export type StringMapEntryParse = { kind: "commit"; key: string; value: string } | { kind: "invalid"; error: string };

/**
 * Add-row validation of the stringMap field kind: key trimmed non-empty
 * ≤128 chars, unique among the map's CURRENT keys (deletion markers included —
 * they still count toward the cap), map stays ≤16 keys, value ≤512 chars (empty
 * LEGAL — env FOO="") — the same rules core's isValidRecordFieldLeaf(stringMap)
 * enforces on the write path.
 */
export function parseStringMapEntry(
  rawKey: string,
  rawValue: string,
  currentKeys: readonly string[],
): StringMapEntryParse {
  const key = rawKey.trim();
  if (key === "") {
    return { kind: "invalid", error: "键不能为空" };
  }
  if (key.length > STRING_MAP_KEY_MAX_LENGTH) {
    return { kind: "invalid", error: `键最长 ${STRING_MAP_KEY_MAX_LENGTH} 个字符` };
  }
  if (currentKeys.includes(key)) {
    return { kind: "invalid", error: "该键已存在" };
  }
  if (currentKeys.length >= STRING_MAP_MAX_ENTRIES) {
    return { kind: "invalid", error: `最多 ${STRING_MAP_MAX_ENTRIES} 条` };
  }
  if (rawValue.length > STRING_MAP_VALUE_MAX_LENGTH) {
    return { kind: "invalid", error: `值最长 ${STRING_MAP_VALUE_MAX_LENGTH} 个字符` };
  }
  return { kind: "commit", key, value: rawValue };
}

/** Upsert one KEY/VALUE pair into the full-map snapshot (aggregated full-map commit semantics). */
export function withStringMapEntry(value: StringMapValue | null, key: string, entry: string): StringMapValue {
  return { ...(value ?? {}), [key]: entry };
}

/**
 * Delete one key with a null deletion marker (the host removes just that key).
 * NEVER collapses to a whole null: pending markers must survive in the snapshot
 * until the host applies them (a null leaf would mean "field unset" and skip
 * the per-key removes).
 */
export function withoutStringMapEntry(value: StringMapValue | null, key: string): StringMapValue {
  const next: StringMapValue = { ...(value ?? {}) };
  if (next[key] !== undefined) {
    next[key] = null;
  }
  return next;
}

// ---------------------------------------------------------------------------
// recordEditor / recordMaster kinds
// ---------------------------------------------------------------------------

/**
 * Narrow a record field leaf to the stringMap shape — a kind "record" value is
 * also an object, so the map's values must be checked (string or null only).
 */
export function isStringMapLeaf(leaf: RecordFieldValue): leaf is StringMapValue {
  return (
    typeof leaf === "object" &&
    leaf !== null &&
    !Array.isArray(leaf) &&
    Object.values(leaf).every((entry) => entry === null || typeof entry === "string")
  );
}

/**
 * Narrow a record field leaf to the nested recordEditor shape (entries are
 * records or null markers) — the twin discriminator of {@link isStringMapLeaf};
 * both accept an empty/all-null object, the field kind decides the editor.
 */
export function isRecordEditorLeaf(leaf: RecordFieldValue): leaf is RecordEditorValue {
  return (
    typeof leaf === "object" &&
    leaf !== null &&
    !Array.isArray(leaf) &&
    Object.values(leaf).every((entry) => entry === null || (typeof entry === "object" && !Array.isArray(entry)))
  );
}

/** Name rules of one recordEditor descriptor (OpencodeSetting["record"] minus fields). */
export interface RecordNameRules {
  namePattern?: string;
  nameMaxLen?: number;
  maxEntries?: number;
}

/** Chinese error for an invalid new-entry name, or null when the name is acceptable. */
export function recordEntryNameError(
  raw: string,
  existingNames: readonly string[],
  rules: RecordNameRules,
): string | null {
  const text = raw.trim();
  if (text === "") {
    return "名称不能为空";
  }
  const nameMaxLen = rules.nameMaxLen ?? RECORD_NAME_MAX_LENGTH;
  if (text.length > nameMaxLen) {
    return `最长 ${nameMaxLen} 个字符`;
  }
  const pattern = rules.namePattern === undefined ? RECORD_NAME_PATTERN : new RegExp(rules.namePattern);
  if (!pattern.test(text)) {
    return "仅限字母、数字与 . _ -";
  }
  if (existingNames.includes(text)) {
    return "名称已存在";
  }
  const maxEntries = rules.maxEntries ?? RECORD_MAX_ENTRIES;
  if (existingNames.length >= maxEntries) {
    return `最多 ${maxEntries} 条`;
  }
  return null;
}

/**
 * Parse a text/multiline field commit: trimmed text, empty → null (field unset),
 * over the kind's bound (text 256 / multiline 8000, field.maxLen overrides) →
 * invalid — the same rules core's isValidRecordFieldLeaf enforces, pre-checked
 * here so the user gets a proper message instead of the protocol backstop error.
 */
export function parseRecordTextField(
  raw: string,
  field: RecordFieldDef,
): { kind: "commit"; value: string | null } | { kind: "invalid"; error: string } {
  return parseBoundedStringInput(raw, recordFieldMaxLen(field));
}

/** Field-kind bound of a text/multiline field (field.maxLen ?? text 256 / multiline 8000). */
export function recordFieldMaxLen(field: RecordFieldDef): number {
  return field.maxLen ?? (field.kind === "multiline" ? RECORD_MULTILINE_MAX_LENGTH : RECORD_TEXT_MAX_LENGTH);
}

/** Entry cap of a record stringList field (field.maxEntries ?? core's 8-entry default). */
export function recordStringListMaxEntries(field: RecordFieldDef): number {
  return field.maxEntries ?? RECORD_STRING_LIST_MAX_ENTRIES;
}

/** One required field left empty by a live entry (drives the commit block + inline errors). */
export interface RecordRequiredGap {
  name: string;
  label: string;
  /** Notice segment replacing the default 的<label>不能为空 (cross-field rules). */
  notice?: string;
}

/** Required-field labels missing from ONE entry (empty string / null / absent leaves). */
function recordEntryGaps(fields: readonly RecordFieldDef[], entry: RecordEntryValue): string[] {
  const labels: string[] = [];
  for (const field of fields) {
    if (field.required !== true) {
      continue;
    }
    const leaf = entry[field.key];
    if (leaf === undefined || leaf === null || (typeof leaf === "string" && leaf.trim() === "")) {
      labels.push(field.label);
    }
  }
  return labels;
}

/**
 * Required fields left empty by the LIVE entries of a snapshot (null markers are
 * deletions and skipped) — the commit gate: while non-empty, NO change may call
 * onChange; the offending entries must be fixed or deleted first.
 */
export function recordRequiredGaps(
  fields: readonly RecordFieldDef[],
  value: RecordEditorValue | null,
): RecordRequiredGap[] {
  const gaps: RecordRequiredGap[] = [];
  for (const [name, entry] of Object.entries(value ?? {})) {
    if (entry === null) {
      continue;
    }
    for (const label of recordEntryGaps(fields, entry)) {
      gaps.push({ name, label });
    }
  }
  return gaps;
}

/**
 * Cross-field rule, deliberately inline (mirror of core's isValidOpencodeSettingValue
 * recordEditor branch — design: NOT a generic framework): an mcpEntries entry of
 * type=remote must carry a usable url. The text-field kind already bounds
 * presence/shape for PRESENT urls; this adds the coupling "remote ⇒ url required"
 * that per-field schemas cannot express. Live entries only (null markers are
 * deletions); the descriptor key is checked at the call site (planRecordCommit).
 */
export function recordMcpRemoteUrlGaps(value: RecordEditorValue | null): RecordRequiredGap[] {
  const gaps: RecordRequiredGap[] = [];
  for (const [name, entry] of Object.entries(value ?? {})) {
    if (entry === null) {
      continue;
    }
    if (entry.type === "remote" && (typeof entry.url !== "string" || entry.url.trim() === "")) {
      gaps.push({ name, label: "URL", notice: "的 remote 条目必须填写 URL" });
    }
  }
  return gaps;
}

/**
 * Cross-field rule, deliberately inline (mirror of core's isValidOpencodeSettingValue
 * recordEditor branch — design: NOT a generic framework): a referenceEntries entry
 * must carry EXACTLY ONE of repository/path, and branch rides only on the
 * repository form. Couplings per-field schemas cannot express. Live entries only
 * (null markers are deletions); the descriptor key is checked at the call site
 * (planRecordCommit).
 */
export function recordReferenceGaps(value: RecordEditorValue | null): RecordRequiredGap[] {
  const gaps: RecordRequiredGap[] = [];
  for (const [name, entry] of Object.entries(value ?? {})) {
    if (entry === null) {
      continue;
    }
    const hasRepository = typeof entry.repository === "string" && entry.repository.trim() !== "";
    const hasPath = typeof entry.path === "string" && entry.path.trim() !== "";
    const hasBranch = typeof entry.branch === "string" && entry.branch.trim() !== "";
    if (hasRepository === hasPath) {
      gaps.push({ name, label: "Git 仓库", notice: "的 Git 仓库与本地路径必须二选一" });
    } else if (hasBranch && !hasRepository) {
      gaps.push({ name, label: "分支", notice: "的分支仅在填写 Git 仓库时可用" });
    }
  }
  return gaps;
}

/** Chinese notice naming the entry that blocks a commit (other entries first, the edited one last). */
export function recordBlockedCommitError(gaps: readonly RecordRequiredGap[], editedName: string): string | null {
  const first = gaps.find((gap) => gap.name !== editedName) ?? gaps[0];
  if (first === undefined) {
    return null;
  }
  return `「${first.name}」${first.notice ?? `的${first.label}不能为空`}，修改已暂存`;
}

/**
 * Upsert one entry into the snapshot (aggregated full-snapshot commit semantics).
 * The mirror end of the seam: when a snapshot built this way collapses to null
 * (see {@link withoutRecordEntry}), core's opencodeSettingEdits recordEditor
 * dispatch turns that null into a whole-key remove.
 */
export function withRecordEntry(
  value: RecordEditorValue | null,
  name: string,
  entry: RecordEntryValue,
): RecordEditorValue {
  return { ...(value ?? {}), [name]: entry };
}

/**
 * Delete one live name: a null deletion marker; collapses to null when nothing live
 * remains. That null is the seam contract with core's opencodeSettingEdits
 * recordEditor dispatch (src/core/opencodeSettings.ts): 空 → null 整键 → the host
 * removes the whole record key, so deleting the last entry truly clears it.
 */
export function withoutRecordEntry(value: RecordEditorValue | null, name: string): RecordEditorValue | null {
  const next: RecordEditorValue = { ...(value ?? {}) };
  next[name] = null;
  return recordLiveCount(next) === 0 ? null : next;
}

/** Count of live (non-null) entries — null entries are deletion markers only. */
function recordLiveCount(value: RecordEditorValue): number {
  return Object.values(value).filter((entry) => entry !== null).length;
}

/** One full-snapshot commit plan: "blocked" holds everything locally, "commit" posts the snapshot. */
export type RecordCommitPlan =
  | { kind: "blocked"; gaps: RecordRequiredGap[] }
  | { kind: "commit"; value: RecordEditorValue | null; postedNames: string[] };

/**
 * Assemble the next full-snapshot commit from the read form: `edits` overlays held
 * field changes onto the live entries (names absent from the read form are
 * never-committed draft adds), `deletedName` marks one live entry as a null
 * deletion marker (rename = delete marker + draft add in one plan). Live entries
 * with empty required fields BLOCK the commit (nothing may post while any gap
 * remains); committable drafts (no gaps + at least one set leaf — an all-empty
 * entry would write nothing) ride along and are reported in postedNames so the
 * caller can drop exactly those working copies. `settingKey` is the descriptor
 * key, used only for the inline mcpEntries cross-field gate below.
 */
export function planRecordCommit(
  fields: readonly RecordFieldDef[],
  value: RecordEditorValue | null,
  edits: Record<string, RecordEntryValue>,
  deletedName: string | null,
  settingKey?: string,
): RecordCommitPlan {
  const snapshot: RecordEditorValue = {};
  for (const [name, entry] of Object.entries(value ?? {})) {
    // The read form never carries null markers; skip defensively anyway.
    if (entry === null) {
      continue;
    }
    snapshot[name] = deletedName === name ? null : { ...entry, ...edits[name] };
  }
  const gaps = recordRequiredGaps(fields, snapshot);
  // Cross-field rules, deliberately inline (design: NOT a generic framework — mirror
  // of core's isValidOpencodeSettingValue recordEditor branch): an mcpEntries entry
  // of type=remote must carry a usable url, and a referenceEntries entry must carry
  // exactly one of repository/path — couplings per-field schemas cannot express.
  if (settingKey === "mcpEntries") {
    gaps.push(...recordMcpRemoteUrlGaps(snapshot));
  }
  if (settingKey === "referenceEntries") {
    gaps.push(...recordReferenceGaps(snapshot));
  }
  if (gaps.length > 0) {
    return { kind: "blocked", gaps };
  }
  const postedNames = Object.keys(snapshot);
  for (const [name, entry] of Object.entries(edits)) {
    if (snapshot[name] === undefined && isCommittableRecordDraft(fields, entry)) {
      snapshot[name] = entry;
      postedNames.push(name);
    }
  }
  return { kind: "commit", value: recordLiveCount(snapshot) === 0 ? null : snapshot, postedNames };
}

/** True when a never-committed draft may enter the snapshot: no gaps and at least one set leaf. */
function isCommittableRecordDraft(fields: readonly RecordFieldDef[], entry: RecordEntryValue): boolean {
  if (recordEntryGaps(fields, entry).length > 0) {
    return false;
  }
  return Object.values(entry).some((leaf: RecordFieldValue) => leaf !== null && leaf !== undefined);
}

/** True while the record key holds named entries — the master select stays locked (已有条目). */
export function isRecordMasterLocked(aggregate: RecordAggregate): boolean {
  return aggregate.mode === "entries" && Object.keys(aggregate.entries).length > 0;
}

/** True while the record key is the boolean master form — the entries editor stays locked (已设全局开关). */
export function isRecordEntriesLocked(aggregate: RecordAggregate): boolean {
  return aggregate.mode === "boolean";
}

/**
 * Next aggregate after one recordEditor/recordMaster commit settles optimistically:
 * the per-name diff of the snapshot onto the read form (null markers delete,
 * absent names untouched), null → unset, booleans → the master form.
 */
export function recordAggregateAfterCommit(
  aggregate: RecordAggregate,
  value: RecordEditorValue | boolean | null,
): RecordAggregate {
  if (typeof value === "boolean") {
    return { mode: "boolean", booleanValue: value, entries: {} };
  }
  if (value === null) {
    return { mode: "unset", booleanValue: null, entries: {} };
  }
  const entries: Record<string, RecordEntryValue> = { ...aggregate.entries };
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null) {
      delete entries[name];
    } else {
      entries[name] = entry;
    }
  }
  return { mode: "entries", booleanValue: null, entries };
}

// ---------------------------------------------------------------------------
// shared layout helper
// ---------------------------------------------------------------------------

/** Kinds whose control spans the full set-row width (set-row-wrap layout in both tabs). */
const WIDE_KINDS: ReadonlySet<string> = new Set([
  "providers",
  "stringList",
  "orderedList",
  "pluginList",
  "enumChips",
  "shallowObject",
  "permissionTools",
  "modelCatalog",
  "recordEditor",
  "recordMaster",
  "agentPairMap",
  "agentTextMap",
  "numberMap",
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
// agentPairMap / agentTextMap kinds (OMO 覆写矩阵 / 提示词)
// ---------------------------------------------------------------------------

/** Live entry of one agentPairMap row (the value-side shape of AgentPairMapValue). */
export type AgentPairEntry = { model: string; reasoning: string | null };

/** Fixed-row state of one agent inside an agentPairMap editor. */
export interface AgentPairRow {
  agent: string;
  /** Live entry; null = the row is 未设置 (key absent OR a null deletion marker). */
  entry: AgentPairEntry | null;
}

/**
 * Fixed rows in descriptor order (options = KNOWN_AGENTS): one row per agent,
 * null deletion markers and absent keys both rendering as 未设置. Whole-null
 * input (key absent in file) renders every row 未设置.
 */
export function agentPairRows(agents: readonly string[], value: AgentPairMapValue | null): AgentPairRow[] {
  return agents.map((agent) => {
    const entry = value?.[agent];
    return { agent, entry: entry ?? null };
  });
}

/**
 * Upsert one agent's live entry into the full-map snapshot. The result is NEVER
 * whole-null: null means 无编辑 (never wipes the agents block), so a pair-map
 * commit always posts an object — even after every row was cleared.
 */
export function withAgentPairEntry(
  value: AgentPairMapValue | null,
  agent: string,
  entry: AgentPairEntry,
): AgentPairMapValue {
  return { ...(value ?? {}), [agent]: entry };
}

/**
 * Clear one agent: a null deletion marker when the row was ever present in the
 * snapshot (live entry or earlier marker); an absent row stays absent (clearing
 * an already-unset row is a no-op). Never collapses to whole-null — an all-null
 * MAP is the valid "remove every listed agent" commit.
 */
export function withoutAgentPairEntry(value: AgentPairMapValue | null, agent: string): AgentPairMapValue {
  const next: AgentPairMapValue = { ...(value ?? {}) };
  if (next[agent] !== undefined) {
    next[agent] = null;
  }
  return next;
}

/**
 * Reasoning requires a model (core's validator demands model in every entry):
 * the reasoning select stays locked until the row carries a live entry.
 */
export function isAgentPairReasoningLocked(row: AgentPairRow): boolean {
  return row.entry === null;
}

/** Fixed-row state of one agent inside an agentTextMap editor. */
export interface AgentTextRow {
  agent: string;
  /** Live text; null = 未设置 (key absent OR a null deletion marker). */
  text: string | null;
}

/** Fixed rows in descriptor order; null markers and absent keys both render 未设置. */
export function agentTextRows(agents: readonly string[], value: AgentTextMapValue | null): AgentTextRow[] {
  return agents.map((agent) => {
    const text = value?.[agent];
    return { agent, text: text ?? null };
  });
}

/** Upsert one agent's text into the full-map snapshot (never whole-null — see withAgentPairEntry). */
export function withAgentTextEntry(value: AgentTextMapValue | null, agent: string, text: string): AgentTextMapValue {
  return { ...(value ?? {}), [agent]: text };
}

/** Clear one agent with a null deletion marker (never whole-null — see withoutAgentPairEntry). */
export function withoutAgentTextEntry(value: AgentTextMapValue | null, agent: string): AgentTextMapValue {
  const next: AgentTextMapValue = { ...(value ?? {}) };
  if (next[agent] !== undefined) {
    next[agent] = null;
  }
  return next;
}

/**
 * Parse one agentText commit: trimmed text, empty → null (remove that agent's
 * leaf), over AGENT_TEXT_MAX_LENGTH → invalid with the Chinese error — the
 * exact bound core's omoSettings validator enforces (protocol-shared constant).
 */
export function parseAgentTextInput(
  raw: string,
): { kind: "commit"; value: string | null } | { kind: "invalid"; error: string } {
  return parseBoundedStringInput(raw, AGENT_TEXT_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// numberMap kind (OMO 编排 / 覆写矩阵)
// ---------------------------------------------------------------------------

/** Live row of a numberMap editor (null entries are deletion markers, not rows). */
export interface NumberMapRow {
  key: string;
  value: number;
}

/** Live entries in insertion order — null markers are deletions already covered by the snapshot. */
export function numberMapRows(value: NumberMapValue | null): NumberMapRow[] {
  const rows: NumberMapRow[] = [];
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== null) {
      rows.push({ key, value: entry });
    }
  }
  return rows;
}

/** Upsert one entry into the full-map snapshot (aggregated full-map commit semantics). */
export function withNumberMapEntry(value: NumberMapValue | null, key: string, entry: number): NumberMapValue {
  return { ...(value ?? {}), [key]: entry };
}

/**
 * Delete one entry: a null deletion marker when the row was ever present in the
 * snapshot; collapses to null (remove the whole key) ONLY for flat maps — a
 * nested leaf map never collapses (null whole-value = 无编辑, never wipes the
 * shared agents/categories block; an all-null MAP is the valid "remove every
 * listed entry" commit).
 */
export function withoutNumberMapEntry(
  value: NumberMapValue | null,
  key: string,
  wholeKeyRemove: boolean,
): NumberMapValue | null {
  const next: NumberMapValue = { ...(value ?? {}) };
  if (next[key] !== undefined && next[key] !== null) {
    next[key] = null;
  } else {
    delete next[key];
  }
  return wholeKeyRemove && numberMapLiveCount(next) === 0 ? null : next;
}

/** Count of live (non-null) entries — null entries are deletion markers only. */
function numberMapLiveCount(value: NumberMapValue): number {
  return Object.values(value).filter((entry) => entry !== null).length;
}

// ---------------------------------------------------------------------------
// free-key agentTextMap rows (提示词 / 分类提示词追加)
// ---------------------------------------------------------------------------

/** Live rows of a free-key agentTextMap editor (options-absent descriptors, e.g. categories). */
export function freeAgentTextRows(value: AgentTextMapValue | null): AgentTextRow[] {
  return Object.entries(value ?? {})
    .filter(([, text]) => text !== null)
    .map(([agent, text]) => ({ agent, text: text as string }));
}
