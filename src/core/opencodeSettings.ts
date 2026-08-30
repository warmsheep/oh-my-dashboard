import { MODEL_ID_PATTERN } from "../constants";
import { OPENCODE_PERMISSION_TOOLS, OPENCODE_SETTINGS, OPENCODE_STRING_VALUE_MAX_LENGTH } from "../shared/protocol";
import type {
  OpencodePermissionState,
  OpencodeSetting,
  OpencodeSettingField,
  OpencodeSettingValue,
  PermissionToolsValue,
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
/** Bounds of the mcpServers kind: server names share the provider-id charset, capped at 32 entries. */
const MCP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MCP_NAME_MAX_LENGTH = 64;
const MCP_SERVERS_MAX_ENTRIES = 32;

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
 * Descriptors with a `file` target or the mcpServers kind are NOT part of this scalar
 * map — their data rides the payload's dedicated tui/mcp fields instead.
 */
export function readOpencodeSettingValues(text: string): Record<string, OpencodeSettingValue> {
  const values: Record<string, OpencodeSettingValue> = {};
  for (const setting of OPENCODE_SETTINGS) {
    if (setting.file !== undefined || setting.kind === "mcpServers") {
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
    case "mcpServers":
      // OMO-side kind / dedicated-payload kind: no OpenCode descriptor reaches here.
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
 * Declared MCP servers from an opencode.json[c] text: object entries only (others
 * cannot carry an `enabled` flag), disabled = `entry.enabled === false`, capped at
 * 32 entries in stable key order.
 */
export function readMcpServers(text: string): { name: string; disabled: boolean }[] {
  const value = getValue<unknown>(text, ["mcp"]);
  if (!isRecord(value)) {
    return [];
  }
  const servers: { name: string; disabled: boolean }[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (servers.length >= MCP_SERVERS_MAX_ENTRIES) {
      break;
    }
    if (!isRecord(entry)) {
      continue;
    }
    servers.push({ name, disabled: entry.enabled === false });
  }
  return servers;
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
 * The edits for one descriptor value. Most kinds produce the single set-or-remove
 * op at the descriptor path (null → remove); the diffing kinds never rewrite whole
 * objects: mcpServers never wipes the `mcp` key (null → no edits; true → set
 * enabled=false; false → remove the enabled override, keeping the entry's other
 * fields), permissionTools emits one set/remove per tool key present in the value,
 * and shallowObject edits per leaf ({@link shallowObjectEdits}). Pure edit builder —
 * value validation lives in {@link isValidOpencodeSettingValue} and is enforced
 * by the caller (ConfigStore.setOpencodeSetting / the panel-host message parse).
 */
export function opencodeSettingEdits(setting: OpencodeSetting, value: OpencodeSettingValue): JsoncEdit[] {
  switch (setting.kind) {
    case "mcpServers": {
      if (value === null || !isRecord(value)) {
        return [];
      }
      const edits: JsoncEdit[] = [];
      for (const [name, disabled] of Object.entries(value)) {
        edits.push(
          disabled === true
            ? { path: ["mcp", name, "enabled"], value: false, op: "set" as const }
            : { path: ["mcp", name, "enabled"], value: undefined, op: "remove" as const },
        );
      }
      return edits;
    }
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
 * be known tools with allow/ask/deny (or null), mcpServers is ≤32 well-formed names
 * mapped to booleans. null (remove op) is always valid.
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
    case "mcpServers": {
      if (!isRecord(value)) {
        return false;
      }
      const names = Object.keys(value);
      if (names.length > MCP_SERVERS_MAX_ENTRIES) {
        return false;
      }
      for (const name of names) {
        if (name.length > MCP_NAME_MAX_LENGTH || !MCP_NAME_PATTERN.test(name) || typeof value[name] !== "boolean") {
          return false;
        }
      }
      return true;
    }
    case "enumChips":
      // OMO-side kind (Wave 2): no OpenCode descriptor uses it; writes are rejected.
      return false;
  }
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
