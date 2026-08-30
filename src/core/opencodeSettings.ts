import { MODEL_ID_PATTERN } from "../constants";
import {
  isSharedShallowObjectParent,
  OPENCODE_MULTILINE_VALUE_MAX_LENGTH,
  OPENCODE_PERMISSION_TOOLS,
  OPENCODE_SETTINGS,
  OPENCODE_STRING_VALUE_MAX_LENGTH,
} from "../shared/protocol";
import type {
  OpencodePermissionState,
  OpencodeRecordStates,
  OpencodeSetting,
  OpencodeSettingField,
  OpencodeSettingValue,
  PermissionToolsValue,
  RecordAggregate,
  RecordEditorValue,
  RecordEntryValue,
  RecordFieldDef,
  RecordFieldValue,
  RecordSchema,
  ShallowObjectValue,
  StringMapValue,
} from "../shared/protocol";
import { getValue } from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";
import { isValidTuiTheme } from "./tuiSettings";
import type { JsonPath } from "./types";

/** Provider ids inside disabled_providers/enabled_providers: npm-ish identifier chars, bounded length. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROVIDER_ID_MAX_LENGTH = 32;
/** Bounded entry count of the providers kind (the webview only offers catalog providers, but the protocol write path stays guarded). */
const DISABLED_PROVIDERS_MAX_ENTRIES = 64;
/** Bounds of the stringList kind (design: 1–16 entries, each trimmed non-empty ≤256 chars). */
const STRING_LIST_MAX_ENTRIES = 16;
const STRING_LIST_ENTRY_MAX_LENGTH = 256;
/** Bounds of the orderedList kind (design: 1–64 entries, each trimmed non-empty ≤64 chars, dupes rejected). */
const ORDERED_LIST_MAX_ENTRIES = 64;
const ORDERED_LIST_ENTRY_MAX_LENGTH = 64;
/**
 * Bounds and charset of the pluginList kind (design: 1–32 entries, each a
 * trimmed non-empty ≤128-char npm name with an optional @version suffix). The
 * charset is deliberately permissive — scoped names, version suffixes and the
 * local path prefixes pluginResolver treats as first-class (~/…, ./…, /…,
 * file://…) all pass; npm stays the real authority, the pattern only rules out
 * whitespace/control surprises. Windows drive-letter paths (C:\…) stay out
 * (note only: `\` is never a plugin-array separator per repo pathSafety
 * conventions). Mirrored in webview-ui/src/controls/helpers.ts (documented
 * sync mirror).
 */
const PLUGIN_LIST_MAX_ENTRIES = 32;
const PLUGIN_LIST_ENTRY_MAX_LENGTH = 128;
const PLUGIN_LIST_ENTRY_PATTERN = /^[@A-Za-z0-9._\-/@+:~]+$/;
/** Default recordEditor name rules (command names, formatter/lsp/mcp ids): npm-ish identifier charset. */
const RECORD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const RECORD_NAME_MAX_LENGTH = 64;
const RECORD_MAX_ENTRIES = 32;
/** Default bounds of recordEditor field kinds: text ≤256, multiline ≤8000, stringList fields ≤8 entries. */
const RECORD_TEXT_MAX_LENGTH = 256;
const RECORD_MULTILINE_MAX_LENGTH = 8000;
const RECORD_STRING_LIST_MAX_ENTRIES = 8;
/**
 * Bounds of the stringMap recordEditor field kind (environment/headers): ≤16
 * entries, keys trimmed non-empty ≤128 chars, values ≤512 chars. Empty values
 * are LEGAL (env FOO="" writes an empty value). Mirrored in
 * webview-ui/src/controls/helpers.ts (documented sync mirror).
 */
const STRING_MAP_MAX_ENTRIES = 16;
const STRING_MAP_KEY_MAX_LENGTH = 128;
const STRING_MAP_VALUE_MAX_LENGTH = 512;

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
    case "pluginList":
      return readPluginListValue(value);
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
 * The pluginList protection flag of the OpenCode tab payload: true when the raw
 * `plugin` array holds at least one entry the UI cannot express — a non-string
 * ([name, options] tuple) OR a string failing the per-entry sanity (blank /
 * over-length). Protected files render the 插件 row read-only, and
 * ConfigStore.setOpencodeSetting rejects their pluginList writes
 * (PLUGIN_PROTECTED) so a stale UI can never silently destroy hand-written
 * entries via whole-array replacement.
 */
export function readPluginProtected(text: string): boolean {
  const value = getValue<unknown>(text, ["plugin"]);
  if (!Array.isArray(value)) {
    return false;
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      return true;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > PLUGIN_LIST_ENTRY_MAX_LENGTH) {
      return true;
    }
  }
  return false;
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
 * All record aggregates of the OpenCode tab payload, keyed by the recordEditor
 * descriptors' path root (command/formatter/lsp/mcp/provider/references). Paths
 * without a matching descriptor stay unset, so the payload slot is always fully materialized.
 */
export function readRecordStates(text: string): OpencodeRecordStates {
  const byPath: Record<string, RecordAggregate> = {
    command: unsetRecordAggregate(),
    formatter: unsetRecordAggregate(),
    lsp: unsetRecordAggregate(),
    mcp: unsetRecordAggregate(),
    provider: unsetRecordAggregate(),
    references: unsetRecordAggregate(),
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
  return {
    command: byPath.command,
    formatter: byPath.formatter,
    lsp: byPath.lsp,
    mcp: byPath.mcp,
    provider: byPath.provider,
    references: byPath.references,
  };
}

/** Fresh unset aggregate (shared default of the read paths). */
function unsetRecordAggregate(): RecordAggregate {
  return { mode: "unset", booleanValue: null, entries: {} };
}

/** One raw entry → its protocol shape: ONLY fields passing their kind coercion survive. */
function coerceRecordEntry(fields: readonly RecordFieldDef[], entry: Record<string, unknown>): RecordEntryValue {
  const out: RecordEntryValue = {};
  for (const field of fields) {
    const coerced = coerceRecordField(field, resolveDottedLeaf(entry, field.key));
    if (coerced !== undefined) {
      out[field.key] = coerced;
    }
  }
  return out;
}

/**
 * Resolve one (possibly dotted) field key against a raw container (shared by the
 * recordEditor entries and the shallowObject values): plain keys read the
 * container's top level, dotted keys (the shared convention, e.g.
 * "options.apiKey" / "permission.edit") traverse the nested containers; a
 * missing or wrong-shaped container reads as absent. The protocol shape stays
 * FLAT (keyed by the dotted string) — only the file side is nested.
 */
function resolveDottedLeaf(container: Record<string, unknown>, fieldKey: string): unknown {
  let current: unknown = container;
  for (const segment of fieldKey.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
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
    case "number":
      // Validator-aligned degrade: out-of-bounds and non-integer leaves read as
      // omitted (like wrong-typed ones), so the read form stays round-trippable.
      return isValidBoundedNumber(leaf, field) ? (leaf as number) : undefined;
    case "stringMap": {
      if (!isRecord(leaf)) {
        return undefined;
      }
      // Filter to bounded keys/values within the entry cap — the same rules
      // isValidRecordFieldLeaf enforces on the write path (0 survivors → omitted).
      const kept: StringMapValue = {};
      for (const [key, entry] of Object.entries(leaf)) {
        const trimmed = key.trim();
        if (
          trimmed.length === 0 ||
          trimmed.length > STRING_MAP_KEY_MAX_LENGTH ||
          typeof entry !== "string" ||
          entry.length > STRING_MAP_VALUE_MAX_LENGTH
        ) {
          continue;
        }
        if (Object.keys(kept).length >= STRING_MAP_MAX_ENTRIES) {
          break;
        }
        kept[key] = entry;
      }
      return Object.keys(kept).length > 0 ? kept : undefined;
    }
    case "record": {
      if (!isRecord(leaf)) {
        return undefined;
      }
      // Validator-aligned degrade (the module's round-trippable contract): sub-entry
      // names failing the level's name rules and entries beyond the cap are dropped
      // from the read form, so a reposted snapshot can never fail the write backstop
      // — hand-written exotic ids (openrouter-style "vendor/model") and overflow
      // entries stay file-only, untouched by UI edits (absent names emit no edits).
      const schema = field.record;
      const pattern = schema?.namePattern === undefined ? RECORD_NAME_PATTERN : new RegExp(schema.namePattern);
      const nameMaxLen = schema?.nameMaxLen ?? RECORD_NAME_MAX_LENGTH;
      const maxEntries = schema?.maxEntries ?? RECORD_MAX_ENTRIES;
      const nestedFields = schema?.fields ?? [];
      const out: RecordEditorValue = {};
      for (const [subName, subEntry] of Object.entries(leaf)) {
        if (Object.keys(out).length >= maxEntries) {
          break;
        }
        if (!isRecord(subEntry) || subName.length > nameMaxLen || !pattern.test(subName)) {
          continue;
        }
        out[subName] = coerceRecordEntry(nestedFields, subEntry);
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
  }
}

/**
 * Per-leaf edits of a shallowObject value at its parent path — shared by the OpenCode
 * and OMO edit builders. With ownsKey (default) the descriptor solely owns the parent
 * key: null, an all-null map and an empty map remove the parent key (恢复默认);
 * otherwise ONE set-or-remove edit per field present in the map (null leaf → remove
 * that field's leaf; dotted field keys address the nested leaf, e.g. "permission.edit"
 * → <object>.permission.edit). With ownsKey=false (a SHARED parent — the agent 扩展
 * rows at agent.<name> beside the model/temperature rows) a null value degenerates to
 * no edits and an all-null map stays per-leaf, so sibling descriptors' and hand-written
 * leaves always survive. NEVER writes the whole object: sibling keys outside the
 * descriptor fields and user comments inside the object must survive. Tolerates
 * non-record values with no edits (callers validate first).
 */
export function shallowObjectEdits(parentPath: JsonPath, value: unknown, ownsKey = true): JsoncEdit[] {
  if (value === null) {
    return ownsKey ? [{ path: parentPath, value: undefined, op: "remove" }] : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  const leaves = Object.entries(value);
  if (ownsKey && leaves.every(([, leaf]) => leaf === null)) {
    return [{ path: parentPath, value: undefined, op: "remove" }];
  }
  const edits: JsoncEdit[] = [];
  for (const [fieldKey, leaf] of leaves) {
    const leafPath = [...parentPath, ...fieldKey.split(".")];
    edits.push(
      leaf === null
        ? { path: leafPath, value: undefined, op: "remove" as const }
        : { path: leafPath, value: leaf, op: "set" as const },
    );
  }
  return edits;
}

/**
 * Per-leaf edits of a recordEditor value at its path: a null entry removes
 * [...path, name]; an object entry emits ONE set-or-remove edit PER FIELD present in
 * the submitted entry object — a null leaf removes [...path, name, ...segments(field.key)],
 * any other leaf sets that path (segments = the RecordFieldDef key split on ".",
 * the documented convention where a dotted key addresses a nested leaf, e.g.
 * "options.apiKey" → entry.options.apiKey; plain keys are single-segment). Entries
 * whose submitted object has no fields emit NO edits: name removal is ONLY the
 * explicit null marker, so unknown/hand-written leaves inside a touched entry are
 * never collateral damage (the provider safety contract — users keep env blocks
 * and options.timeout there). An entry left with no fields may leave an empty {}
 * container behind on disk — the same tolerated residue as permissionTools.
 * stringMap markers apply per map key (null map entries drop their keys); an
 * all-marker or empty live map removes the field's leaf. Names absent from the
 * value are untouched, so broken hand-written entries and advanced fields survive.
 * Rename = old name null + new name fields in one value. A null VALUE itself
 * null-guards to no edits — the whole-key remove for it lives in the descriptor
 * dispatch ({@link opencodeSettingEdits}), so raw callers can never wipe the key
 * by accident. `fields` (the descriptor's field schemas) enables kind-aware
 * dispatch: when provided, keys with no field schema are skipped (validated
 * upstream) and record-kind leaves recurse into one more level of the same
 * per-leaf semantics at the field's path (null removes the whole field leaf, a
 * null sub-entry removes that name, an object sub-entry edits only ITS present
 * fields — hand-written sub-entries and advanced leaves inside a touched
 * sub-entry survive); without fields the legacy shape-based behavior
 * (record-shaped leaves treated as stringMaps) is kept. Pure edit builder —
 * value validation lives in {@link isValidOpencodeSettingValue} and is enforced
 * by callers.
 */
export function recordEditorEdits(path: JsonPath, value: unknown, fields?: readonly RecordFieldDef[]): JsoncEdit[] {
  if (value === null || !isRecord(value)) {
    return [];
  }
  return recordEntriesEdits(path, value, fields);
}

/** The per-name loop shared by the descriptor root and every nested record field. */
function recordEntriesEdits(
  path: JsonPath,
  value: Record<string, unknown>,
  fields?: readonly RecordFieldDef[],
): JsoncEdit[] {
  const fieldByKey = fields === undefined ? null : new Map(fields.map((field) => [field.key, field]));
  const edits: JsoncEdit[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null) {
      edits.push({ path: [...path, name], value: undefined, op: "remove" });
      continue;
    }
    if (!isRecord(entry)) {
      continue; // tolerated residue (callers validate first)
    }
    for (const [fieldKey, leaf] of Object.entries(entry)) {
      const leafPath = [...path, name, ...fieldKey.split(".")];
      const field = fieldByKey?.get(fieldKey);
      if (field !== undefined && field.kind === "record") {
        edits.push(...recordFieldEdits(leafPath, leaf, field));
        continue;
      }
      if (fieldByKey !== null && field === undefined) {
        continue; // unknown field — callers validate first; tolerated no-op
      }
      if (leaf === null) {
        edits.push({ path: leafPath, value: undefined, op: "remove" });
        continue;
      }
      if (!isRecordFieldValue(leaf)) {
        continue; // tolerated residue (callers validate first)
      }
      if (isRecord(leaf)) {
        // stringMap leaf: null entries are per-key deletion markers — apply them
        // here (drop the keys); an all-marker/empty map removes the field's leaf.
        const live: StringMapValue = {};
        for (const [mapKey, mapValue] of Object.entries(leaf)) {
          if (mapValue !== null) {
            live[mapKey] = mapValue;
          }
        }
        edits.push(
          Object.keys(live).length > 0
            ? { path: leafPath, value: live, op: "set" as const }
            : { path: leafPath, value: undefined, op: "remove" as const },
        );
        continue;
      }
      edits.push({ path: leafPath, value: leaf, op: "set" });
    }
  }
  return edits;
}

/** One "record"-kind leaf at its resolved path: null removes the whole leaf, records recurse. */
function recordFieldEdits(leafPath: JsonPath, leaf: unknown, field: RecordFieldDef): JsoncEdit[] {
  if (leaf === null) {
    return [{ path: leafPath, value: undefined, op: "remove" }];
  }
  if (!isRecord(leaf)) {
    return []; // tolerated residue (callers validate first)
  }
  return recordEntriesEdits(leafPath, leaf, field.record?.fields ?? []);
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
    typeof value === "number" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string")) ||
    (isRecord(value) && Object.values(value).every((entry) => entry === null || typeof entry === "string"))
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
      // Shared parents (agent.<name> beside the model/temperature rows) keep the
      // edits per-leaf — the whole-key 恢复默认 collapse would wipe sibling
      // descriptors' leaves (see isSharedShallowObjectParent).
      return shallowObjectEdits(setting.path, value, !isSharedShallowObjectParent(setting));
    case "recordEditor":
      // The UI collapses "no live entry remains" into null (空 → null 整键); the
      // descriptor dispatch translates that into a whole-key remove, while the bare
      // recordEditorEdits helper still null-guards raw input to no edits.
      return value === null
        ? [{ path: setting.path, value: undefined, op: "remove" }]
        : recordEditorEdits(setting.path, value, setting.record?.fields);
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
 * String-kind validator: a trimmed non-empty string of at most maxLen chars (the
 * same shape isValidTuiTheme enforces for tui.json themes; maxLen comes from the
 * descriptor's maxLen, defaulting to the shared OPENCODE_STRING_VALUE_MAX_LENGTH).
 */
function isValidBoundedSettingString(value: unknown, maxLen: number): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen;
}

/**
 * Host-side value validator (guards the protocol write path against arbitrary JSONC
 * injection): model ids must be provider/model, enums must be listed options, tristate
 * is true|false|"notify", booleans are booleans, strings are trimmed non-empty and
 * ≤ the descriptor maxLen (default OPENCODE_STRING_VALUE_MAX_LENGTH; file:"tui"
 * strings use isValidTuiTheme instead), numbers are finite and within
 * the descriptor bounds (integers only when the descriptor is integer-flagged; decimals
 * allowed otherwise), providers are ≤64 unique well-formed ids, stringList is 1–16 unique
 * trimmed non-empty ≤256-char entries, orderedList is 1–64 unique trimmed non-empty ≤64-char
 * entries, shallowObject leaves must match their field schemas (bool/enum/bounded
 * string/shared-rules stringList/bounded number; null leaf = field unset),
 * permissionTools keys must
 * be known tools with allow/ask/deny (or null), recordEditor bounds entry names
 * (charset/length/≤32) and each entry's fields per kind (required fields non-empty;
 * stringList fields ≤8 entries; number fields finite within bounds; stringMap fields
 * ≤16 bounded entries with string-or-null values; mcpEntries additionally couples
 * type=remote ⇒ url; referenceEntries additionally couples repository⇔path
 * exclusivity + branch ⇒ repository), recordMaster is true|false (null remove
 * handled above). null (remove op) is always valid.
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
        : isValidBoundedSettingString(value, setting.maxLen ?? OPENCODE_STRING_VALUE_MAX_LENGTH);
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
    case "pluginList":
      return isValidPluginListValue(value);
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
      if (!isValidRecordEditorShape(setting.record, value)) {
        return false;
      }
      // Cross-field rules, deliberately inline (design: NOT a generic framework),
      // checked on the shape-validated entries: an mcpEntries entry of type=remote
      // must carry a usable url — the text-field kind already bounds presence/shape
      // for PRESENT urls, this adds the coupling "remote ⇒ url required" that
      // per-field schemas cannot express.
      for (const entry of Object.values(value)) {
        if (entry === null) {
          continue;
        }
        if (setting.key === "mcpEntries") {
          if (entry.type === "remote" && (typeof entry.url !== "string" || entry.url.trim().length === 0)) {
            return false;
          }
        }
        // A referenceEntries entry must carry EXACTLY ONE of repository/path (schema
        // $defs git/local variants are disjoint), and branch rides only on the
        // repository form — couplings per-field schemas cannot express.
        if (setting.key === "referenceEntries") {
          const hasRepository = typeof entry.repository === "string" && entry.repository.trim().length > 0;
          const hasPath = typeof entry.path === "string" && entry.path.trim().length > 0;
          const hasBranch = typeof entry.branch === "string" && entry.branch.trim().length > 0;
          if (hasRepository === hasPath || (hasBranch && !hasRepository)) {
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
 * One recordEditor LEVEL against its name rules and per-entry schemas — shared by
 * the descriptor root (recordEditor kind) and nested "record"-kind fields: a
 * record value whose names fit the charset/length/entry cap and whose non-null
 * entries pass {@link isValidRecordEntry} with the level's field schemas. Type
 * predicate: on true the value is a well-formed RecordEditorValue (non-null
 * entries are records), letting callers iterate without re-checking shapes.
 */
function isValidRecordEditorShape(record: RecordSchema | undefined, value: unknown): value is RecordEditorValue {
  if (!isRecord(value)) {
    return false;
  }
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
    // null entry = delete marker (write path removes the name).
    const entry = value[name];
    if (entry !== null && (!isRecord(entry) || !isValidRecordEntry(fields, entry))) {
      return false;
    }
  }
  return true;
}

/**
 * One recordEditor entry against its field schemas: every present key must be a known
 * field (unknown keys are rejected, mirroring shallowObject); null/absent leaves mean
 * "field unset" and are rejected for required fields; every other leaf must pass its
 * kind rules (text/multiline trimmed non-empty within maxLen, enum ∈ options, model
 * id shape, boolean, stringList 1..field.maxEntries unique trimmed ≤256-char entries,
 * number finite within bounds, stringMap ≤16 bounded entries with string-or-null
 * values, record = a nested recordEditor level with its own name rules).
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
    case "number":
      return isValidBoundedNumber(leaf, field);
    case "stringMap":
      return isValidRecordStringMap(leaf);
    case "record":
      return isValidRecordEditorShape(field.record, leaf);
  }
}

/**
 * stringMap leaf validator (recordEditor environment/headers): plain object of
 * ≤16 entries, keys trimmed non-empty ≤128 chars, values strings ≤512 chars
 * (empty LEGAL — env FOO="") or null (= remove that key).
 */
function isValidRecordStringMap(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length > STRING_MAP_MAX_ENTRIES) {
    return false;
  }
  for (const key of keys) {
    const trimmed = key.trim();
    if (trimmed.length === 0 || trimmed.length > STRING_MAP_KEY_MAX_LENGTH) {
      return false;
    }
    const entry = value[key];
    if (entry !== null && typeof entry !== "string") {
      return false;
    }
    if (typeof entry === "string" && entry.length > STRING_MAP_VALUE_MAX_LENGTH) {
      return false;
    }
  }
  return true;
}

/**
 * Number-leaf rules shared by shallowObject fields and recordEditor number
 * fields: finite, integer when flagged, within inclusive bounds (absent =
 * unbounded).
 */
function isValidBoundedNumber(value: unknown, field: { min?: number; max?: number; integer?: boolean }): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  if (field.integer === true && !Number.isInteger(value)) {
    return false;
  }
  return value >= (field.min ?? Number.NEGATIVE_INFINITY) && value <= (field.max ?? Number.POSITIVE_INFINITY);
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
 * One shallowObject leaf against its field schema: bool, a listed enum option, a
 * trimmed non-empty string within maxLen (string default the shared string
 * bound, multiline default OPENCODE_MULTILINE_VALUE_MAX_LENGTH), a shared-rules
 * string list, or a finite number within bounds (integer-only when flagged).
 */
export function isValidShallowObjectLeaf(
  field: OpencodeSettingField,
  value: unknown,
): value is boolean | number | string | string[] {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (field.options ?? []).includes(value);
    case "string":
      return isValidBoundedSettingString(value, field.maxLen ?? OPENCODE_STRING_VALUE_MAX_LENGTH);
    case "multiline":
      return isValidBoundedSettingString(value, field.maxLen ?? OPENCODE_MULTILINE_VALUE_MAX_LENGTH);
    case "stringList":
      return isValidStringListValue(value);
    case "number":
      return isValidBoundedNumber(value, field);
  }
}

/**
 * Extract the descriptor fields of a shallowObject raw value (shared by the OpenCode and
 * OMO read paths): non-objects → null; ONLY the descriptor fields are surfaced (dotted
 * keys resolve through the nested containers — {@link resolveDottedLeaf}), and leaves
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
    const leaf = resolveDottedLeaf(value, field.key);
    out[field.key] = isValidShallowObjectLeaf(field, leaf) ? leaf : null;
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

/**
 * pluginList write rules: 1–32 unique trimmed non-empty ≤128-char entries of
 * the permissive npm-ish charset incl. local path prefixes (dupes compared
 * after trim, case-sensitive). Mirrors {@link readPluginListValue}'s per-entry
 * sanity so reads stay round-trippable.
 */
function isValidPluginListValue(value: unknown): boolean {
  if (!isValidUniqueStringEntries(value, PLUGIN_LIST_MAX_ENTRIES, PLUGIN_LIST_ENTRY_MAX_LENGTH)) {
    return false;
  }
  return (value as string[]).every((entry) => PLUGIN_LIST_ENTRY_PATTERN.test(entry));
}

/**
 * pluginList read: an array whose EVERY entry is a string passing the per-entry
 * sanity (trimmed non-empty ≤128) surfaces as-is; any other entry — a
 * non-string ([name, options] tuple) or a sanity-failing string (blank /
 * over-length, e.g. a long file:// path) — degrades to null AND raises the
 * payload's dedicated pluginProtected flag, so the row renders read-only and
 * the host write gate blocks whole-array replacement (nothing is silently
 * destroyed). Non-arrays degrade to null like every other kind.
 */
function readPluginListValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > PLUGIN_LIST_ENTRY_MAX_LENGTH) {
      return null;
    }
  }
  return value;
}
