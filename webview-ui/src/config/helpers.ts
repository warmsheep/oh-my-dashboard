import { OMO_SETTING_GROUP_ORDER, type OmoMiscSetting, type PresetRow } from "@shared/protocol";

/** One 功能设置 sub-block: OMO_MISC_SETTINGS rows sharing the same group label. */
export interface OmoSettingGroup {
  label: string;
  settings: OmoMiscSetting[];
}

/**
 * Group settings by their group field: listed groups follow the canonical
 * groupOrder, unlisted groups trail after them in first-appearance order.
 */
export function groupOmoMiscSettings(
  settings: readonly OmoMiscSetting[],
  groupOrder: readonly string[] = OMO_SETTING_GROUP_ORDER,
): OmoSettingGroup[] {
  const byLabel = new Map<string, OmoSettingGroup>();
  for (const setting of settings) {
    const label = setting.group;
    let group = byLabel.get(label);
    if (!group) {
      group = { label, settings: [] };
      byLabel.set(label, group);
    }
    group.settings.push(setting);
  }
  const ordered: OmoSettingGroup[] = [];
  for (const label of groupOrder) {
    const group = byLabel.get(label);
    if (group) {
      ordered.push(group);
      byLabel.delete(label);
    }
  }
  return [...ordered, ...byLabel.values()];
}

/**
 * Effective value a scalar control shows: file value ?? descriptor default ?? false.
 * The default is optional (composite kinds carry no default), so boolean kinds
 * without one display as false — honest "unset" rendering, matching the OpenCode
 * tab's effectiveOpencodeBoolean semantics.
 */
export function effectiveOmoValue(
  value: boolean | number | null | undefined,
  setting: OmoMiscSetting,
): boolean | number {
  if (value !== null && value !== undefined) {
    return value;
  }
  return setting.default ?? false;
}

/**
 * Result of parsing a 功能设置 number commit: "commit" posts the value (null = empty →
 * remove the key, back to the descriptor default), "noop" keeps the state unchanged and
 * posts nothing (non-integer text), "invalid" keeps the raw draft and shows the Chinese
 * bounds error without posting.
 */
export type OmoNumberParse =
  { kind: "commit"; value: number | null } | { kind: "noop" } | { kind: "invalid"; error: string };

/**
 * Parse a 功能设置 number-field commit against the descriptor bounds (min ?? 0,
 * max ?? 100 — the same source core's isValidOmoMiscValue validates against).
 */
export function parseOmoNumberInput(raw: string, setting: OmoMiscSetting): OmoNumberParse {
  const text = raw.trim();
  if (text === "") {
    return { kind: "commit", value: null };
  }
  if (!/^[+-]?\d+$/.test(text)) {
    return { kind: "noop" };
  }
  const min = setting.min ?? 0;
  const max = setting.max ?? 100;
  const value = Number.parseInt(text, 10);
  if (value < min || value > max) {
    return { kind: "invalid", error: `需为 ${min}–${max} 的整数` };
  }
  return { kind: "commit", value };
}

/**
 * Upsert one row's model/variant (matched by section+name): patches in place when
 * the row exists, appends a full row otherwise. Needed because the host may send
 * configured rows only — the known-name placeholders exist solely as mergeRows
 * output at render time, so an optimistic edit to one has nowhere to land without
 * the append branch.
 */
export function upsertRow(
  rows: readonly PresetRow[],
  section: PresetRow["section"],
  name: string,
  patch: { model: string | null; variant: string | null },
): PresetRow[] {
  const index = rows.findIndex((r) => r.section === section && r.name === name);
  if (index < 0) {
    return [...rows, { section, name, model: patch.model, variant: patch.variant }];
  }
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
}
