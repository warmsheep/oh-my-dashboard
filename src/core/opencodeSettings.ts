import { MODEL_ID_PATTERN } from "../constants";
import { OPENCODE_PERMISSION_TOOLS, OPENCODE_SETTINGS, OPENCODE_STRING_VALUE_MAX_LENGTH } from "../shared/protocol";
import type {
  OpencodePermissionState,
  OpencodeRecordStates,
  OpencodeSetting,
  OpencodeSettingField,
  OpencodeSettingValue,
  PermissionToolsValue,
  RecordAggregate,
  RecordEntryValue,
  RecordFieldDef,
  RecordFieldValue,
  ShallowObjectValue,
} from "../shared/protocol";
import { getValue } from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";
import { isValidTuiTheme } from "./tuiSettings";
import type { JsonPath } from "./types";

/** Provider ids inside disabled_providers: npm-ish identifier chars, bounded length. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROVIDER_ID_MAX_LENGTH = 32;
/** Bounded entry count of disabled_providers (the webview only offers catalog providers, but the protocol write path stays guarded). */
const DISABLED_PROVIDERS_MAX_ENTRIES = 64;
/** Bounds of the stringList kind (design: 1–16 entries, each trimmed non-empty ≤256 chars). */
const STRING_LIST_MAX_ENTRIES = 16;
const STRING_LIST_ENTRY_MAX_LENGTH = 256;
/** Bounds of the orderedList kind (design: 1–64 entries, each trimmed non-empty ≤64 chars, dupes rejected). */
const ORDERED_LIST_MAX_ENTRIES = 64;
const ORDERED_LIST_ENTRY_MAX_LENGTH = 64;
/** Default recordEditor name rules (command names, formatter/lsp/mcp ids): npm-ish identifier charset. */
const RECORD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const RECORD_NAME_MAX_LENGTH = 64;
const RECORD_MAX_ENTRIES = 32;
/** Default bounds of recordEditor field kinds: text ≤256, multiline ≤8000, stringList fields ≤8 entries. */
const RECORD_TEXT_MAX_LENGTH = 256;
const RECORD_MULTILINE_MAX_LENGTH = 8000;
const RECORD_STRING_LIST_MAX_ENTRIES = 8;

/** Non-array object guard (JSONC leaves are `unknown`; arrays are objects too). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Permission action literals shared by the read paths and the validator. */
function isPermissionAction(value: unknown): value is "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Read every OPENCODE_SETTINGS value from an opencode.json[c] text (display-tolerant:
 * absent and wrong-shaped values read as null so the UI never lies about types).
 * Descriptors with a `file` target or a dedicated payload field (recordEditor /
 * recordMaster kinds — command/formatter/lsp/mcp) are NOT part of this scalar map —
 * their data rides the payload's dedicated tui/records fields instead.
 */
export function readOpencodeSettingValues(text: string): Record<string, OpencodeSettingValue> {
  const values: Record<string, OpencodeSettingValue> = {};
  for (const setting of OPENCODE_SETTINGS) {
    if (setting.file !== undefined || setting.kind === "recordEditor" || setting.kind === "recordMaster") {
      continue;
    }
    values[setting.key] = coerceReadValue(setting, getValue<unknown>(text, setting.path));
  }
  return values;
}

/** One descriptor value → its protocol shape; undefined (absent) and wrong shapes become null. */
function coerceReadValue(setting: OpencodeSetting, value: unknown): OpencodeSettingValue {
  if (value === undefined) {
    return null;
  }
  switch (setting.kind) {
    case "model":
    case "enum":
    case "string":
      return typeof value === "string" ? value : null;
    case "tristate":
      return value === true || value === false || value === "notify" ? value : null;
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "providers":
    case "stringList":
    case "orderedList":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
    case "shallowObject":
      return extractShallowObjectValue(setting.fields ?? [], value);
    case "permissionTools": {
      if (!isRecord(value)) {
        return null;
      }
      const tools: PermissionToolsValue = {};
      for (const [tool, action] of Object.entries(value)) {
        if (OPENCODE_PERMISSION_TOOLS.includes(tool) && isPermissionAction(action)) {
          tools[tool] = action;
        }
      }
      return tools;
    }
    case "enumChips":
    case "recordEditor":
    case "recordMaster":
      // OMO-side kind / dedicated-payload kinds: no OpenCode descriptor reaches here.
      return null;
  }
}

/**
 * The permission aggregate of the OpenCode tab payload: string form → shorthand;
 * object form → per-tool actions (allow/ask/deny) plus the tool names whose values
 * are hand-written pattern objects (advancedTools). Absent/garbage → all-empty.
 */
export function readPermissionState(text: string): OpencodePermissionState {
  const value = getValue<unknown>(text, ["permission"]);
  if (isPermissionAction(value)) {
    return { shorthand: value, tools: {}, advancedTools: [] };
  }
  if (!isRecord(value)) {
    return { shorthand: null, tools: {}, advancedTools: [] };
  }
  const tools: PermissionToolsValue = {};
  const advancedTools: string[] = [];
  for (const [tool, action] of Object.entries(value)) {
    if (!OPENCODE_PERMISSION_TOOLS.includes(tool)) {
      continue;
    }
    if (isPermissionAction(action)) {
      tools[tool] = action;
    } else if (isRecord(action)) {
      advancedTools.push(tool);
    }
  }
  return { shorthand: null, tools, advancedTools };
}

/**
 * The record aggregate of one recordEditor path (command/formatter/lsp/mcp): a boolean
 * value reads as the master form, an object as the named-entry form (non-object
 * entries SKIPPED; per-entry leaves failing their field kind — wrong-typed OR
 * validator-incompatible (empty/over-long text, non-unique/over-cap stringList) — are
 * OMITTED, not nulled; a command missing its template still shows, with the field
 * absent, for repair); absent/garbage reads as unset. Display-tolerant like every
 * read path, and round-trippable: whatever survives coercion passes the write validator.
 */
export function readRecordState(text: string, path: JsonPath, fields: readonly RecordFieldDef[]): RecordAggregate {
  const value = getValue<unknown>(text, path);
  if (value === undefined) {
    return unsetRecordAggregate();
  }
  if (typeof value === "boolean") {
    return { mode: "boolean", booleanValue: value, entries: {} };
  }
  if (!isRecord(value)) {
    return unsetRecordAggregate();
  }
  const entries: Record<string, RecordEntryValue> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry)) {
      entries[name] = coerceRecordEntry(fields, entry);
    }
  }
  return { mode: "entries", booleanValue: null, entries };
}

/**
 * All four record aggregates of the OpenCode tab payload, keyed by the recordEditor
 * descriptors' path root (command/formatter/lsp/mcp). Paths without a matching descriptor
 * stay unset, so the payload slot is always fully materialized.
 */
export function readRecordStates(text: string): OpencodeRecordStates {
  const byPath: Record<string, RecordAggregate> = {
    command: unsetRecordAggregate(),
    formatter: unsetRecordAggregate(),
    lsp: unsetRecordAggregate(),
    mcp: unsetRecordAggregate(),
  };
  for (const setting of OPENCODE_SETTINGS) {
    if (setting.kind !== "recordEditor") {
      continue;
    }
    const key = setting.path[0];
    if (Object.hasOwn(byPath, key)) {
      byPath[key] = readRecordState(text, setting.path, setting.record?.fields ?? []);
    }
  }
  return { command: byPath.command, formatter: byPath.formatter, lsp: byPath.lsp, mcp: byPath.mcp };
}

/** Fresh unset aggregate (shared default of the read paths). */
function unsetRecordAggregate(): RecordAggregate {
  return { mode: "unset", booleanValue: null, entries: {} };
}

/** One raw entry → its protocol shape: ONLY fields passing their kind coercion survive. */
function coerceRecordEntry(fields: readonly RecordFieldDef[], entry: Record<string, unknown>): RecordEntryValue {
  const out: RecordEntryValue = {};
  for (const field of fields) {
    const coerced = coerceRecordField(field, entry[field.key]);
    if (coerced !== undefined) {
      out[field.key] = coerced;
    }
  }
  return out;
}

/** One leaf against its field kind; undefined = omitted (absent, wrong-shaped or validator-incompatible). */
function coerceRecordField(field: RecordFieldDef, leaf: unknown): RecordFieldValue | undefined {
  switch (field.kind) {
    case "text":
    case "multiline": {
      // Validator-aligned degrade: empty-trimmed and over-maxLen strings read as
      // omitted (like wrong-typed leaves), so the read form never shows a value the
      // write backstop would reject — a hand-broken entry surfaces as a repair gap.
      const maxLen =
        field.maxLen ?? (field.kind === "multiline" ? RECORD_MULTILINE_MAX_LENGTH : RECORD_TEXT_MAX_LENGTH);
      return typeof leaf === "string" && isValidBoundedRecordText(leaf, maxLen) ? leaf : undefined;
    }
    case "boolean":
      return typeof leaf === "boolean" ? leaf : undefined;
    case "enum":
      return typeof leaf === "string" && (field.options ?? []).includes(leaf) ? leaf : undefined;
    case "model":
      return typeof leaf === "string" && MODEL_ID_PATTERN.test(leaf) ? leaf : undefined;
    case "stringList": {
      if (!Array.isArray(leaf) || !leaf.every((entry) => typeof entry === "string")) {
        return undefined;
      }
      // Filter to unique trimmed non-empty ≤256-char entries within the field cap —
      // the same rules isValidRecordFieldLeaf enforces on the write path (0 survivors → omitted).
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const entry of leaf) {
        const trimmed = entry.trim();
        if (trimmed.length === 0 || trimmed.length > STRING_LIST_ENTRY_MAX_LENGTH || seen.has(trimmed)) {
          continue;
        }
        seen.add(trimmed);
        if (kept.length < (field.maxEntries ?? RECORD_STRING_LIST_MAX_ENTRIES)) {
          kept.push(entry);
        }
      }
      return kept.length > 0 ? kept : undefined;
    }
  }
}

/**
 * Per-leaf edits of a shallowObject value at its parent path — shared by the OpenCode
 * and OMO edit builders. null, an all-null map and an empty map remove the parent key
 * (恢复默认); otherwise ONE set-or-remove edit per field present in the map (null leaf →
 * remove that field key). NEVER writes the whole object: sibling keys outside the
 * descriptor fields (e.g. runtime_fallback.enabled, owned by a different descriptor
 * sharing the parent) and user comments inside the object must survive. Tolerates
 * non-record values with no edits (callers validate first).
 */
export function shallowObjectEdits(parentPath: JsonPath, value: unknown): JsoncEdit[] {
  if (value === null) {
    return [{ path: parentPath, value: undefined, op: "remove" }];
  }
  if (!isRecord(value)) {
    return [];
  }
  const leaves = Object.entries(value);
  if (leaves.every(([, leaf]) => leaf === null)) {
    return [{ path: parentPath, value: undefined, op: "remove" }];
  }
  const edits: JsoncEdit[] = [];
  for (const [fieldKey, leaf] of leaves) {
    edits.push(
      leaf === null
        ? { path: [...parentPath, fieldKey], value: undefined, op: "remove" as const }
        : { path: [...parentPath, fieldKey], value: leaf, op: "set" as const },
    );
  }
  return edits;
}

/**
 * Per-name edits of a recordEditor value at its path (mirrors the modelCatalog diff):
 * a null entry removes [...path, name]; an object entry sets the name with NULL LEAVES
 * PRUNED (a pruned-empty entry removes the name — never writes {}); names absent from
 * the map are untouched, so broken hand-written entries and advanced fields survive.
 * Rename = old name null + new name set in one value. A null VALUE itself null-guards
 * to no edits — the whole-key remove for it lives in the descriptor dispatch
 * ({@link opencodeSettingEdits}), so raw callers can never wipe the key by accident.
 * Pure edit builder — value validation lives in {@link isValidOpencodeSettingValue}
 * and is enforced by callers.
 */
export function recordEditorEdits(path: JsonPath, value: unknown): JsoncEdit[] {
  if (value === null || !isRecord(value)) {
    return [];
  }
  const edits: JsoncEdit[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null) {
      edits.push({ path: [...path, name], value: undefined, op: "remove" });
      continue;
    }
    if (!isRecord(entry)) {
      continue; // tolerated residue (callers validate first)
    }
    const pruned: RecordEntryValue = {};
    for (const [fieldKey, leaf] of Object.entries(entry)) {
      if (isRecordFieldValue(leaf)) {
        pruned[fieldKey] = leaf;
      }
    }
    edits.push(
      Object.keys(pruned).length === 0
        ? { path: [...path, name], value: undefined, op: "remove" as const }
        : { path: [...path, name], value: pruned, op: "set" as const },
    );
  }
  return edits;
}

/**
 * The single set-or-remove edit of a recordMaster value (true/false → set the boolean,
 * null → remove the key). The UI interlock prevents writing a boolean over an
 * entries-form file shape; the core deliberately stays pure and does not re-check
 * the file (same read-tolerant contract as every other edit builder).
 */
export function recordMasterEdits(path: JsonPath, value: boolean | null): JsoncEdit[] {
  return [value === null ? { path, value: undefined, op: "remove" } : { path, value, op: "set" }];
}

/** Field-leaf shape guard of the write path (schema rules live in the validator; this only prunes nulls). */
function isRecordFieldValue(value: unknown): value is RecordFieldValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

/**
 * The edits for one descriptor value. Most kinds produce the single set-or-remove
 * op at the descriptor path (null → remove); the diffing kinds never rewrite whole
 * objects: permissionTools emits one set/remove per tool key present in the value,
 * shallowObject edits per leaf ({@link shallowObjectEdits}), recordEditor diffs
 * per entry name ({@link recordEditorEdits}) and recordMaster is the plain
 * boolean set/remove ({@link recordMasterEdits}). Pure edit builder — value
 * validation lives in {@link isValidOpencodeSettingValue} and is enforced
 * by the caller (ConfigStore.setOpencodeSetting / the panel-host message parse).
 */
export function opencodeSettingEdits(setting: OpencodeSetting, value: OpencodeSettingValue): JsoncEdit[] {
  switch (setting.kind) {
    case "permissionTools": {
      // Accepted residue: removing the last tool key can leave an empty `permission: {}`
      // container behind. Cleaning it up would require reading the file's current content
      // (this builder is pure and deliberately sees none), and every read tolerates the
      // empty object (readPermissionState / readOpencodeSettingValues degrade it to
      // "unset"), so the residue is left as-is by design.
      if (value === null || !isRecord(value)) {
        return [];
      }
      const edits: JsoncEdit[] = [];
      for (const [tool, action] of Object.entries(value)) {
        edits.push(
          action === null
            ? { path: ["permission", tool], value: undefined, op: "remove" as const }
            : { path: ["permission", tool], value: action, op: "set" as const },
        );
      }
      return edits;
    }
    case "shallowObject":
      return shallowObjectEdits(setting.path, value);
    case "recordEditor":
      // The UI collapses "no live entry remains" into null (空 → null 整键); the
      // descriptor dispatch translates that into a whole-key remove, while the bare
      // recordEditorEdits helper still null-guards raw input to no edits.
      return value === null
        ? [{ path: setting.path, value: undefined, op: "remove" }]
        : recordEditorEdits(setting.path, value);
    case "recordMaster":
      // Kind validation guarantees true|false|null here; anything else is a tolerated no-op.
      return value === true || value === false || value === null ? recordMasterEdits(setting.path, value) : [];
    default:
      return [
        value === null
          ? { path: setting.path, value: undefined, op: "remove" }
          : { path: setting.path, value, op: "set" },
      ];
  }
}

/**
 * Host-side value validator (guards the protocol write path against arbitrary JSONC
 * injection): model ids must be provider/model, enums must be listed options, tristate
 * is true|false|"notify", booleans are booleans, strings are 1..OPENCODE_STRING_VALUE_MAX_LENGTH
 * chars (file:"tui" strings use isValidTuiTheme instead), numbers are finite and within
 * the descriptor bounds (integers only when the descriptor is integer-flagged; decimals
 * allowed otherwise), providers are ≤64 unique well-formed ids, stringList is 1–16 unique
 * trimmed non-empty ≤256-char entries, orderedList is 1–64 unique trimmed non-empty ≤64-char
 * entries, shallowObject leaves must match their field schemas (null leaf = field
 * unset), permissionTools keys must
 * be known tools with allow/ask/deny (or null), recordEditor bounds entry names
 * (charset/length/≤32) and each entry's fields per kind (required fields non-empty;
 * stringList fields ≤8 entries; mcpEntries additionally couples type=remote ⇒ url),
 * recordMaster is true|false (null remove handled above). null (remove op) is always valid.
 */
export function isValidOpencodeSettingValue(setting: OpencodeSetting, value: unknown): boolean {
  if (value === null) {
    return true;
  }
  switch (setting.kind) {
    case "model":
      return typeof value === "string" && MODEL_ID_PATTERN.test(value);
    case "enum":
      return typeof value === "string" && (setting.options ?? []).includes(value);
    case "tristate":
      return value === true || value === false || value === "notify";
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return setting.file === "tui"
        ? isValidTuiTheme(value)
        : typeof value === "string" && value.length > 0 && value.length <= OPENCODE_STRING_VALUE_MAX_LENGTH;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return false;
      }
      if (setting.integer === true && !Number.isInteger(value)) {
        return false;
      }
      return value >= (setting.min ?? Number.NEGATIVE_INFINITY) && value <= (setting.max ?? Number.POSITIVE_INFINITY);
    }
    case "providers": {
      if (!Array.isArray(value) || value.length > DISABLED_PROVIDERS_MAX_ENTRIES) {
        return false;
      }
      const seen = new Set<string>();
      for (const entry of value) {
        if (typeof entry !== "string" || entry.length > PROVIDER_ID_MAX_LENGTH || !PROVIDER_ID_PATTERN.test(entry)) {
          return false;
        }
        if (seen.has(entry)) {
          return false;
        }
        seen.add(entry);
      }
      return true;
    }
    case "stringList":
      return isValidStringListValue(value);
    case "orderedList":
      return isValidOrderedStringListValue(value);
    case "shallowObject": {
      if (!isRecord(value)) {
        return false;
      }
      const fields = new Map((setting.fields ?? []).map((field) => [field.key, field]));
      for (const [key, leaf] of Object.entries(value)) {
        const field = fields.get(key);
        // null leaf = "field unset" (written as a per-leaf remove); every other leaf must match its schema.
        if (field === undefined || (leaf !== null && !isValidShallowObjectLeaf(field, leaf))) {
          return false;
        }
      }
      return true;
    }
    case "permissionTools": {
      if (!isRecord(value)) {
        return false;
      }
      for (const [tool, action] of Object.entries(value)) {
        if (!OPENCODE_PERMISSION_TOOLS.includes(tool)) {
          return false;
        }
        if (action !== null && !isPermissionAction(action)) {
          return false;
        }
      }
      return true;
    }
    case "recordEditor": {
      if (!isRecord(value)) {
        return false;
      }
      const record = setting.record;
      const names = Object.keys(value);
      if (names.length > (record?.maxEntries ?? RECORD_MAX_ENTRIES)) {
        return false;
      }
      const pattern = record?.namePattern === undefined ? RECORD_NAME_PATTERN : new RegExp(record.namePattern);
      const nameMaxLen = record?.nameMaxLen ?? RECORD_NAME_MAX_LENGTH;
      const fields = record?.fields ?? [];
      for (const name of names) {
        if (name.length > nameMaxLen || !pattern.test(name)) {
          return false;
        }
        const entry = value[name];
        // null entry = delete marker (write path removes the name).
        if (entry !== null && (!isRecord(entry) || !isValidRecordEntry(fields, entry))) {
          return false;
        }
        // Cross-field rule, deliberately inline (design: NOT a generic framework):
        // an mcpEntries entry of type=remote must carry a usable url — the text-field
        // kind already bounds presence/shape for PRESENT urls, this adds the coupling
        // "remote ⇒ url required" that per-field schemas cannot express.
        if (setting.key === "mcpEntries" && entry !== null) {
          if (entry.type === "remote" && (typeof entry.url !== "string" || entry.url.trim().length === 0)) {
            return false;
          }
        }
      }
      return true;
    }
    case "recordMaster":
      return value === true || value === false;
    case "enumChips":
      // OMO-side kind (Wave 2): no OpenCode descriptor uses it; writes are rejected.
      return false;
  }
}

/**
 * One recordEditor entry against its field schemas: every present key must be a known
 * field (unknown keys are rejected, mirroring shallowObject); null/absent leaves mean
 * "field unset" and are rejected for required fields; every other leaf must pass its
 * kind rules (text/multiline trimmed non-empty within maxLen, enum ∈ options, model
 * id shape, boolean, stringList 1..field.maxEntries unique trimmed ≤256-char entries).
 */
function isValidRecordEntry(fields: readonly RecordFieldDef[], entry: Record<string, unknown>): boolean {
  const knownKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(entry)) {
    if (!knownKeys.has(key)) {
      return false;
    }
  }
  for (const field of fields) {
    const leaf = entry[field.key];
    if (leaf === undefined || leaf === null) {
      // Absent/null leaf = field unset — required fields must not be unset.
      if (field.required === true) {
        return false;
      }
      continue;
    }
    if (!isValidRecordFieldLeaf(field, leaf)) {
      return false;
    }
  }
  return true;
}

/** One recordEditor leaf against its field kind (bounds default per kind, see RECORD_* constants). */
function isValidRecordFieldLeaf(field: RecordFieldDef, leaf: unknown): boolean {
  switch (field.kind) {
    case "text":
      return isValidBoundedRecordText(leaf, field.maxLen ?? RECORD_TEXT_MAX_LENGTH);
    case "multiline":
      return isValidBoundedRecordText(leaf, field.maxLen ?? RECORD_MULTILINE_MAX_LENGTH);
    case "boolean":
      return typeof leaf === "boolean";
    case "enum":
      return typeof leaf === "string" && (field.options ?? []).includes(leaf);
    case "model":
      return typeof leaf === "string" && MODEL_ID_PATTERN.test(leaf);
    case "stringList":
      return isValidUniqueStringEntries(
        leaf,
        field.maxEntries ?? RECORD_STRING_LIST_MAX_ENTRIES,
        STRING_LIST_ENTRY_MAX_LENGTH,
      );
  }
}

/** Trimmed non-empty string of at most maxLen chars (recordEditor text/multiline fields). */
function isValidBoundedRecordText(leaf: unknown, maxLen: number): boolean {
  if (typeof leaf !== "string") {
    return false;
  }
  const trimmed = leaf.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen;
}

/**
 * One shallowObject leaf against its field schema: bool, a listed enum option, or a
 * finite number within bounds (integer-only when flagged).
 */
export function isValidShallowObjectLeaf(field: OpencodeSettingField, value: unknown): boolean {
  if (field.kind === "boolean") {
    return typeof value === "boolean";
  }
  if (field.kind === "enum") {
    return typeof value === "string" && (field.options ?? []).includes(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  if (field.integer === true && !Number.isInteger(value)) {
    return false;
  }
  return value >= (field.min ?? Number.NEGATIVE_INFINITY) && value <= (field.max ?? Number.POSITIVE_INFINITY);
}

/**
 * Extract the descriptor fields of a shallowObject raw value (shared by the OpenCode and
 * OMO read paths): non-objects → null; ONLY the descriptor fields are surfaced, and leaves
 * failing their field schema (kind, options membership, bounds, integer flag) degrade to
 * null — reads stay round-trippable through the write validator, so the UI never shows a
 * value it cannot commit back.
 */
export function extractShallowObjectValue(
  fields: readonly OpencodeSettingField[],
  value: unknown,
): ShallowObjectValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const out: ShallowObjectValue = {};
  for (const field of fields) {
    const leaf = value[field.key];
    out[field.key] = isValidShallowObjectLeaf(field, leaf) ? (leaf as boolean | number | string) : null;
  }
  return out;
}

/**
 * Shared entry rules of the list kinds: 1..maxEntries unique trimmed non-empty entries
 * of ≤maxEntryLength chars (stringList and orderedList differ ONLY in these bounds).
 */
function isValidUniqueStringEntries(value: unknown, maxEntries: number, maxEntryLength: number): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxEntries) {
    return false;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return false;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > maxEntryLength) {
      return false;
    }
    if (seen.has(trimmed)) {
      return false;
    }
    seen.add(trimmed);
  }
  return true;
}

/** Shared stringList entry rules (opencode instructions + OMO stringList kind): 1–16 unique trimmed non-empty ≤256-char entries. */
export function isValidStringListValue(value: unknown): boolean {
  return isValidUniqueStringEntries(value, STRING_LIST_MAX_ENTRIES, STRING_LIST_ENTRY_MAX_LENGTH);
}

/** orderedList entry rules (OMO agent_order): 1–64 unique trimmed non-empty ≤64-char entries — order carries meaning, dupes rejected. */
export function isValidOrderedStringListValue(value: unknown): boolean {
  return isValidUniqueStringEntries(value, ORDERED_LIST_MAX_ENTRIES, ORDERED_LIST_ENTRY_MAX_LENGTH);
}
