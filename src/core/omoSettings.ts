import { MODEL_ID_PATTERN } from "../constants";
import {
  AGENT_TEXT_MAX_LENGTH,
  OMO_MISC_SETTINGS,
  OMO_REASONING_LEVELS,
  OPENCODE_STRING_VALUE_MAX_LENGTH,
} from "../shared/protocol";
import type {
  AgentPairMapValue,
  AgentTextMapValue,
  ModelCatalogValue,
  OmoMiscSetting,
  OmoMiscValues,
  OmoSettingValue,
} from "../shared/protocol";
import { getValue } from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";
import {
  extractShallowObjectValue,
  isRecord,
  isValidOrderedStringListValue,
  isValidShallowObjectLeaf,
  isValidStringListValue,
  shallowObjectEdits,
} from "./opencodeSettings";
import type { JsonPath } from "./types";

/** Bounds of the enumChips kind: unique option entries, capped at 32 (design: 勾选集快照). */
const ENUM_CHIPS_MAX_ENTRIES = 32;
/** Bounds of the modelCatalog kind: ≤32 aliases, each ≤32 chars of identifier charset (provider-id-like). */
const MODEL_CATALOG_MAX_ENTRIES = 32;
const MODEL_ALIAS_MAX_LENGTH = 32;
const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Effective key path of a descriptor at the target's scope: plugin (default) keys get the
 * sectionPath prefix (omo `[opencode]` block / legacy top level), shared keys live at the
 * TOP LEVEL of the target file for BOTH targets — never under `[opencode]`.
 */
function effectivePath(sectionPath: JsonPath, setting: OmoMiscSetting): JsonPath {
  return setting.scope === "shared" ? setting.path : [...sectionPath, ...setting.path];
}

/** One raw value → its protocol shape for the descriptor's kind; absent and wrong shapes read as null. */
function coerceOmoValue(setting: OmoMiscSetting, value: unknown): OmoSettingValue {
  if (value === undefined) {
    return null;
  }
  switch (setting.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "enum":
    case "string":
      return typeof value === "string" ? value : null;
    case "stringList":
    case "orderedList":
    case "enumChips":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
    case "shallowObject":
      return extractShallowObjectValue(setting.fields ?? [], value);
    case "modelCatalog":
      return coerceModelCatalogValue(value);
    case "agentPairMap":
      return coerceAgentPairMapValue(setting, value);
    case "agentTextMap":
      return coerceAgentTextMapValue(setting, value);
  }
}

/**
 * The modelCatalog read: entries with a non-object value, a missing/invalid model, or an
 * unknown reasoning level are SKIPPED (the write path never touches aliases absent from
 * the submitted map, so broken hand-written entries survive instead of being wiped); null
 * entries are never produced by reads — null only marks deletion intent from the UI.
 */
function coerceModelCatalogValue(value: unknown): ModelCatalogValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const catalog: ModelCatalogValue = {};
  for (const [alias, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      continue;
    }
    const model = entry.model;
    if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) {
      continue;
    }
    const reasoning = entry.reasoning;
    if (reasoning !== undefined && reasoning !== null) {
      if (typeof reasoning !== "string" || !OMO_REASONING_LEVELS.includes(reasoning)) {
        continue;
      }
      catalog[alias] = { model, reasoning };
    } else {
      catalog[alias] = { model, reasoning: null };
    }
  }
  return catalog;
}

/**
 * The agentPairMap read (batch 5): one lookup at the effective `agents` path, then per
 * options-agent extraction of agents.<name>.<leafKey>. Entries with a non-object value
 * or a missing/invalid model are SKIPPED (broken hand-written overrides survive instead
 * of being wiped — the write path never touches agents absent from the submitted map);
 * an invalid reasoning string degrades to null inside the entry (display-safe); agents
 * outside the options key set never surface. Null entries are never produced by reads —
 * null only marks deletion intent from the UI.
 */
function coerceAgentPairMapValue(setting: OmoMiscSetting, value: unknown): AgentPairMapValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const leafKey = setting.agents?.leafKey ?? "";
  const map: AgentPairMapValue = {};
  for (const agent of setting.options ?? []) {
    const agentEntry = value[agent];
    if (!isRecord(agentEntry)) {
      continue;
    }
    const override = agentEntry[leafKey];
    if (!isRecord(override)) {
      continue;
    }
    const model = override.model;
    if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) {
      continue;
    }
    const reasoning = override.reasoning;
    map[agent] = {
      model,
      reasoning: typeof reasoning === "string" && OMO_REASONING_LEVELS.includes(reasoning) ? reasoning : null,
    };
  }
  return map;
}

/**
 * The agentTextMap read (batch 5): per options-agent string leaf at
 * agents.<name>.<leafKey> — non-strings, empty-after-trim and over-{@link AGENT_TEXT_MAX_LENGTH}
 * strings are omitted; agents outside the options key set never surface.
 */
function coerceAgentTextMapValue(setting: OmoMiscSetting, value: unknown): AgentTextMapValue | null {
  if (!isRecord(value)) {
    return null;
  }
  const leafKey = setting.agents?.leafKey ?? "";
  const map: AgentTextMapValue = {};
  for (const agent of setting.options ?? []) {
    const agentEntry = value[agent];
    if (!isRecord(agentEntry)) {
      continue;
    }
    const text = agentEntry[leafKey];
    if (typeof text !== "string") {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > AGENT_TEXT_MAX_LENGTH) {
      continue;
    }
    map[agent] = text;
  }
  return map;
}

/**
 * Read every OMO_MISC_SETTINGS value from an agent-config text at the target's scope:
 * omo targets read plugin-scope keys ONLY at [...sectionPath, ...path] (the `[opencode]`
 * block) while shared-scope keys read at the top level, and legacy targets
 * (sectionPath = []) read everything top-level — the same key names, two generations of
 * the oh-my-openagent runtime. Absent/wrong-shaped values read as null.
 */
export function readOmoMiscValues(text: string, sectionPath: JsonPath): OmoMiscValues {
  const values: OmoMiscValues = {};
  for (const setting of OMO_MISC_SETTINGS) {
    values[setting.key] = coerceOmoValue(setting, getValue<unknown>(text, effectivePath(sectionPath, setting)));
  }
  return values;
}

/**
 * The edits for one descriptor value at the target's scope (scope-aware: shared keys are
 * never prefixed with the sectionPath). Kinds: scalar and list kinds produce the single
 * set-or-remove op (null → remove); shallowObject edits per leaf via the shared
 * {@link shallowObjectEdits} (null leaf → remove that field; null value or an all-null
 * map → remove the key); modelCatalog emits one set/remove per alias (null entry →
 * remove that alias; reasoning null → only `model` is written; value null →
 * remove the whole key); agentPairMap/agentTextMap emit one set/remove per agent at
 * agents.<name>.<leafKey (null entry → remove that leafKey; a null VALUE produces no
 * edits — never removes, or risks wiping, the shared `agents` config block, the same
 * philosophy as the mcp recordEditor). Pure edit builder — value validation lives in
 * {@link isValidOmoMiscValue} and is enforced by callers.
 */
export function omoMiscEdits(sectionPath: JsonPath, setting: OmoMiscSetting, value: OmoSettingValue): JsoncEdit[] {
  const fullPath = effectivePath(sectionPath, setting);
  switch (setting.kind) {
    case "boolean":
    case "number":
    case "enum":
    case "string":
    case "stringList":
    case "orderedList":
    case "enumChips":
      return [
        value === null ? { path: fullPath, value: undefined, op: "remove" } : { path: fullPath, value, op: "set" },
      ];
    case "shallowObject":
      return shallowObjectEdits(fullPath, value);
    case "modelCatalog": {
      if (value === null) {
        return [{ path: fullPath, value: undefined, op: "remove" }];
      }
      if (!isRecord(value)) {
        return [];
      }
      const edits: JsoncEdit[] = [];
      for (const [alias, entry] of Object.entries(value)) {
        edits.push(
          entry === null
            ? { path: [...fullPath, alias], value: undefined, op: "remove" as const }
            : {
                path: [...fullPath, alias],
                value:
                  entry.reasoning === null
                    ? { model: entry.model }
                    : { model: entry.model, reasoning: entry.reasoning },
                op: "set" as const,
              },
        );
      }
      return edits;
    }
    case "agentPairMap": {
      if (value === null || !isRecord(value)) {
        return [];
      }
      const leafKey = setting.agents?.leafKey ?? "";
      const edits: JsoncEdit[] = [];
      for (const [agent, entry] of Object.entries(value)) {
        if (entry === null) {
          edits.push({ path: [...fullPath, agent, leafKey], value: undefined, op: "remove" });
        } else if (isRecord(entry)) {
          edits.push({
            path: [...fullPath, agent, leafKey],
            value:
              entry.reasoning === null || entry.reasoning === undefined
                ? { model: entry.model }
                : { model: entry.model, reasoning: entry.reasoning },
            op: "set",
          });
        }
      }
      return edits;
    }
    case "agentTextMap": {
      if (value === null || !isRecord(value)) {
        return [];
      }
      const leafKey = setting.agents?.leafKey ?? "";
      const edits: JsoncEdit[] = [];
      for (const [agent, text] of Object.entries(value)) {
        if (text === null) {
          edits.push({ path: [...fullPath, agent, leafKey], value: undefined, op: "remove" });
        } else if (typeof text === "string") {
          edits.push({ path: [...fullPath, agent, leafKey], value: text, op: "set" });
        }
      }
      return edits;
    }
  }
}

/**
 * Host-side value validator (guards the protocol write path): boolean kind accepts
 * booleans, number kind accepts integers within the descriptor bounds (min ?? 0,
 * max ?? 100), enum kind accepts listed options only, string kind accepts trimmed
 * non-empty strings within maxLen (default OPENCODE_STRING_VALUE_MAX_LENGTH),
 * enumChips entries must be unique members of the descriptor options (≤32),
 * stringList follows the shared entry rules, orderedList follows the ordered entry
 * rules (1–64 unique trimmed non-empty ≤64-char entries), shallowObject leaves must
 * match their field schemas (null leaf = field unset), modelCatalog bounds the alias
 * charset/count and the model/reasoning shapes, agentPairMap bounds the agent keys
 * to the descriptor options plus the model/reasoning shapes, agentTextMap bounds
 * the agent keys and the trimmed ≤8000 text shape (null entry = delete marker).
 * null (remove op / 恢复默认) is always valid.
 */
export function isValidOmoMiscValue(setting: OmoMiscSetting, value: unknown): boolean {
  if (value === null) {
    return true;
  }
  switch (setting.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number": {
      const min = setting.min ?? 0;
      const max = setting.max ?? 100;
      return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
    }
    case "enum":
      return typeof value === "string" && (setting.options ?? []).includes(value);
    case "string": {
      if (typeof value !== "string") {
        return false;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 && trimmed.length <= (setting.maxLen ?? OPENCODE_STRING_VALUE_MAX_LENGTH);
    }
    case "enumChips": {
      if (!Array.isArray(value) || value.length > ENUM_CHIPS_MAX_ENTRIES) {
        return false;
      }
      const options = setting.options ?? [];
      const seen = new Set<string>();
      for (const entry of value) {
        if (typeof entry !== "string" || !options.includes(entry) || seen.has(entry)) {
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
        // null leaf = "field unset" (dropped on write); every other leaf must match its schema.
        if (field === undefined || (leaf !== null && !isValidShallowObjectLeaf(field, leaf))) {
          return false;
        }
      }
      return true;
    }
    case "modelCatalog": {
      if (!isRecord(value)) {
        return false;
      }
      const aliases = Object.keys(value);
      if (aliases.length > MODEL_CATALOG_MAX_ENTRIES) {
        return false;
      }
      for (const alias of aliases) {
        if (alias.length > MODEL_ALIAS_MAX_LENGTH || !MODEL_ALIAS_PATTERN.test(alias)) {
          return false;
        }
        const entry = value[alias];
        if (entry === null) {
          continue;
        }
        if (!isRecord(entry) || typeof entry.model !== "string" || !MODEL_ID_PATTERN.test(entry.model)) {
          return false;
        }
        const reasoning = entry.reasoning;
        // Absent reasoning key counts as the null form ({ model } object literals).
        if (
          reasoning !== undefined &&
          reasoning !== null &&
          (typeof reasoning !== "string" || !OMO_REASONING_LEVELS.includes(reasoning))
        ) {
          return false;
        }
      }
      return true;
    }
    case "agentPairMap": {
      if (!isRecord(value)) {
        return false;
      }
      const options = setting.options ?? [];
      for (const [agent, entry] of Object.entries(value)) {
        if (!options.includes(agent)) {
          return false;
        }
        if (entry === null) {
          continue;
        }
        if (!isRecord(entry) || typeof entry.model !== "string" || !MODEL_ID_PATTERN.test(entry.model)) {
          return false;
        }
        const reasoning = entry.reasoning;
        // Absent reasoning key counts as the null form ({ model } object literals).
        if (
          reasoning !== undefined &&
          reasoning !== null &&
          (typeof reasoning !== "string" || !OMO_REASONING_LEVELS.includes(reasoning))
        ) {
          return false;
        }
      }
      return true;
    }
    case "agentTextMap": {
      if (!isRecord(value)) {
        return false;
      }
      const options = setting.options ?? [];
      for (const [agent, text] of Object.entries(value)) {
        if (!options.includes(agent)) {
          return false;
        }
        if (text === null) {
          continue;
        }
        if (typeof text !== "string") {
          return false;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0 || trimmed.length > AGENT_TEXT_MAX_LENGTH) {
          return false;
        }
      }
      return true;
    }
  }
}
