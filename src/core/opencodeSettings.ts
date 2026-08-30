import { MODEL_ID_PATTERN } from "../constants";
import { OPENCODE_SETTINGS, OPENCODE_STRING_VALUE_MAX_LENGTH } from "../shared/protocol";
import type { OpencodeSetting, OpencodeSettingValue } from "../shared/protocol";
import { getValue } from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";

/** Provider ids inside disabled_providers: npm-ish identifier chars, bounded length. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROVIDER_ID_MAX_LENGTH = 32;
/** Bounded entry count of disabled_providers (the webview only offers catalog providers, but the protocol write path stays guarded). */
const DISABLED_PROVIDERS_MAX_ENTRIES = 64;

/**
 * Read every OPENCODE_SETTINGS value from an opencode.json[c] text (display-tolerant:
 * absent and wrong-shaped values read as null so the UI never lies about types).
 */
export function readOpencodeSettingValues(text: string): Record<string, OpencodeSettingValue> {
  const values: Record<string, OpencodeSettingValue> = {};
  for (const setting of OPENCODE_SETTINGS) {
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
    case "providers":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  }
}

/**
 * The single set-or-remove edit for one descriptor value (null → remove op). Pure edit
 * builder — value validation lives in {@link isValidOpencodeSettingValue} and is enforced
 * by the caller (ConfigStore.setOpencodeSetting / the panel-host message parse).
 */
export function opencodeSettingEdits(setting: OpencodeSetting, value: OpencodeSettingValue): JsoncEdit[] {
  return [
    value === null ? { path: setting.path, value: undefined, op: "remove" } : { path: setting.path, value, op: "set" },
  ];
}

/**
 * Host-side value validator (guards the protocol write path against arbitrary JSONC
 * injection): model ids must be provider/model, enums must be listed options, tristate
 * is true|false|"notify", booleans are booleans, strings are 1..OPENCODE_STRING_VALUE_MAX_LENGTH
 * chars, providers are ≤64 unique well-formed ids. null (remove op) is always valid.
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
      return typeof value === "string" && value.length > 0 && value.length <= OPENCODE_STRING_VALUE_MAX_LENGTH;
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
  }
}
