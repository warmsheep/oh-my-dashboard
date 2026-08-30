import type { ModelOption, OpencodeSetting, OpencodeSettingValue } from "@shared/protocol";
import { OPENCODE_STRING_VALUE_MAX_LENGTH } from "@shared/protocol";

/** Tristate values a select can commit (null = 未设置, the key gets removed). */
export type TristateValue = boolean | "notify" | null;

/** One labeled group of OpenCode setting rows (descriptors carry the Chinese group label). */
export interface OpencodeSettingGroup {
  label: string;
  settings: OpencodeSetting[];
}

/** Trailing group for descriptors without a group label (group is required, so this is defensive only). */
const FALLBACK_GROUP_LABEL = "其他";

/**
 * Group OPENCODE_SETTINGS rows by their descriptor group field, preserving
 * first-appearance order (same derivation as the OMO tab's groupOmoMiscSettings).
 */
export function groupOpencodeSettings(settings: readonly OpencodeSetting[]): OpencodeSettingGroup[] {
  const groups: OpencodeSettingGroup[] = [];
  const byLabel = new Map<string, OpencodeSettingGroup>();
  for (const setting of settings) {
    const label = setting.group || FALLBACK_GROUP_LABEL;
    let group = byLabel.get(label);
    if (!group) {
      group = { label, settings: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.settings.push(setting);
  }
  return groups;
}

/** Selectable tristate options (select values are strings; "" means 未设置). */
export const TRISTATE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "true", label: "开启" },
  { value: "false", label: "关闭" },
  { value: "notify", label: "仅通知" },
];

/** Select value of the current tristate (anything but true/false/"notify" renders as 未设置). */
export function tristateToSelectValue(value: OpencodeSettingValue | undefined): string {
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (value === "notify") {
    return "notify";
  }
  return "";
}

/** Inverse of {@link tristateToSelectValue}: "" → null (remove the key). */
export function tristateFromSelectValue(value: string): TristateValue {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "notify") {
    return "notify";
  }
  return null;
}

/** Effective boolean a switch shows: file value ?? documented default (no default = false). */
export function effectiveOpencodeBoolean(value: OpencodeSettingValue | undefined, setting: OpencodeSetting): boolean {
  if (value === true || value === false) {
    return value;
  }
  return setting.default === true;
}

/** Unique provider names from the model catalog, preserving first-appearance order (chip list order). */
export function uniqueProviderNames(models: readonly ModelOption[]): string[] {
  const names: string[] = [];
  for (const model of models) {
    if (!names.includes(model.provider)) {
      names.push(model.provider);
    }
  }
  return names;
}

/** Next disabled-providers array after one chip toggles; the caller posts the full array ([] → null). */
export function toggleProviderValue(current: readonly string[], provider: string, checked: boolean): string[] {
  if (!checked) {
    return current.filter((name) => name !== provider);
  }
  return current.includes(provider) ? [...current] : [...current, provider];
}

/**
 * Result of parsing a string-field commit: "commit" posts the value (null = empty →
 * remove the key), "invalid" keeps the raw draft and shows the Chinese length error
 * without posting.
 */
export type OpencodeStringParse = { kind: "commit"; value: string | null } | { kind: "invalid"; error: string };

/**
 * Parse a string-field commit: trimmed text, empty → commit null (remove the key),
 * over OPENCODE_STRING_VALUE_MAX_LENGTH → invalid (the same bound core's
 * isValidOpencodeSettingValue enforces, checked here so the user gets a proper
 * message instead of the protocol backstop error).
 */
export function parseOpencodeStringInput(raw: string): OpencodeStringParse {
  const text = raw.trim();
  if (text === "") {
    return { kind: "commit", value: null };
  }
  if (text.length > OPENCODE_STRING_VALUE_MAX_LENGTH) {
    return { kind: "invalid", error: `最长 ${OPENCODE_STRING_VALUE_MAX_LENGTH} 个字符` };
  }
  return { kind: "commit", value: text };
}
