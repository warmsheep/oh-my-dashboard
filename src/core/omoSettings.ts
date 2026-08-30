import { OMO_MISC_SETTINGS } from "../shared/protocol";
import type { OmoMiscSetting, OmoMiscValues } from "../shared/protocol";
import { getValue } from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";
import type { JsonPath } from "./types";

/**
 * Read every OMO_MISC_SETTINGS value from an agent-config text at the target's scope:
 * omo targets read ONLY at [...sectionPath, ...path] (the `[opencode]` block), legacy
 * targets (sectionPath = []) read at the top-level path — the same key names, two
 * generations of the oh-my-openagent runtime. Absent/wrong-shaped values read as null.
 */
export function readOmoMiscValues(text: string, sectionPath: JsonPath): OmoMiscValues {
  const values: OmoMiscValues = {};
  for (const setting of OMO_MISC_SETTINGS) {
    const value = getValue<unknown>(text, [...sectionPath, ...setting.path]);
    if (setting.kind === "boolean") {
      values[setting.key] = typeof value === "boolean" ? value : null;
    } else {
      values[setting.key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
  }
  return values;
}

/**
 * The single set-or-remove edit for one descriptor value at the target's scope (omo
 * targets get the sectionPath prefix, legacy targets write top-level). Pure edit
 * builder — validation lives in {@link isValidOmoMiscValue} and is enforced by callers.
 */
export function omoMiscEdits(
  sectionPath: JsonPath,
  setting: OmoMiscSetting,
  value: boolean | number | null,
): JsoncEdit[] {
  const fullPath = [...sectionPath, ...setting.path];
  return [value === null ? { path: fullPath, value: undefined, op: "remove" } : { path: fullPath, value, op: "set" }];
}

/**
 * Host-side value validator: boolean kind accepts booleans, number kind accepts
 * integers within the descriptor bounds (min ?? 0, max ?? 100). null (remove op /
 * 恢复默认) is always valid.
 */
export function isValidOmoMiscValue(setting: OmoMiscSetting, value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (setting.kind === "boolean") {
    return typeof value === "boolean";
  }
  const min = setting.min ?? 0;
  const max = setting.max ?? 100;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
