import type { PresetRow, WebviewInitPayload } from "@shared/protocol";

/** Variant values, derived from the frozen protocol (PresetRow["variant"]). */
export type Variant = NonNullable<PresetRow["variant"]>;

export type ModelOption = WebviewInitPayload["models"][number];

export interface FormState {
  name: string;
  description: string;
  rows: PresetRow[];
}

/**
 * Batch-set the model of every row.
 *
 * Documented choice: rows whose model is `null` stay `null` — an unset row
 * means "inherit the default configuration", and 「全部模型设为…」 only
 * re-targets rows the user has explicitly configured.
 */
export function setAllModels(
  rows: readonly PresetRow[],
  model: string,
): PresetRow[] {
  return rows.map((r) => (r.model === null ? r : { ...r, model }));
}

/**
 * Union of the known row names and the rows currently present:
 * known names first (in known-list order), then any extra names sorted
 * alphabetically. Known names missing from `current` become placeholder
 * rows (model/variant `null`). Only rows of `section` are considered.
 */
export function mergeRows(
  known: readonly string[],
  current: readonly PresetRow[],
  section: PresetRow["section"],
): PresetRow[] {
  const own = current.filter((r) => r.section === section);
  const byName = new Map(own.map((r) => [r.name, r]));

  const merged: PresetRow[] = [];
  const seen = new Set<string>();
  for (const name of known) {
    seen.add(name);
    merged.push(
      byName.get(name) ?? { section, name, model: null, variant: null },
    );
  }

  const extras = own
    .filter((r) => !seen.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...merged, ...extras];
}

/**
 * Deep compare name + description + rows (section, name, model, variant,
 * element-wise — row order is deterministic via mergeRows, so reordering
 * counts as dirty).
 */
export function isDirty(initial: FormState, current: FormState): boolean {
  if (initial.name !== current.name) return true;
  if ((initial.description ?? "") !== (current.description ?? "")) return true;
  if (initial.rows.length !== current.rows.length) return true;
  return initial.rows.some((r, i) => {
    const c = current.rows[i];
    return (
      r.section !== c.section ||
      r.name !== c.name ||
      r.model !== c.model ||
      r.variant !== c.variant
    );
  });
}

/** Variant ↔ select value mapping: the empty string represents `null` ('—'). */
export function variantLabel(variant: Variant | null): string {
  return variant ?? "";
}

/** Inverse of {@link variantLabel}: '' → null, otherwise the variant itself. */
export function variantFromLabel(label: string): Variant | null {
  return label === "" ? null : (label as Variant);
}

/** Group models by provider, preserving first-appearance order of providers. */
export function groupModelsByProvider(
  models: readonly ModelOption[],
): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return groups;
}

export function countConfigured(rows: readonly PresetRow[]): number {
  return rows.reduce((n, r) => (r.model !== null ? n + 1 : n), 0);
}
