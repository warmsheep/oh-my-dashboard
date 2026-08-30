import type { OpencodeSettingField, ShallowObjectValue } from "@shared/protocol";
import { useState } from "react";

import {
  effectiveShallowBoolean,
  parseNumberFieldInput,
  parseShallowMultilineInput,
  parseShallowStringInput,
  shallowLeafEdit,
} from "./helpers";
import StringListEditor from "./StringListEditor";

/**
 * shallowObject-kind editor: one row per descriptor field. Boolean fields render the
 * shared s-switch showing value ?? field.default ?? false; number fields render a
 * draft text input committing on blur/Enter (empty → null = 未设置, decimals allowed
 * unless field.integer, bounds from the field — invalid input keeps the draft and
 * shows the inline Chinese error); enum fields render a select (未设置 + field
 * options — the read path nulls out-of-option leaves, so every shown value is
 * committable); string fields render a bounded draft text input (same commit path,
 * length bound field.maxLen ?? the shared string cap); multiline fields render a
 * textarea committing on blur ONLY (Enter inserts a newline — the RecordEditor
 * multiline pattern, no explicit save affordance); stringList fields reuse
 * StringListEditor. Default commits send the FULL field map with nulls for unset
 * fields; partialCommit rows (shared-parent descriptors, e.g. the agent 扩展) send a
 * single-field edit map instead ({@link shallowLeafEdit}), so sibling leaves the read
 * cannot surface are never collateral damage.
 */
export default function ShallowObjectFields({
  fields,
  value,
  disabled,
  partialCommit,
  onChange,
}: {
  /** Field schemas from the descriptor (label / kind / bounds / default). */
  fields: readonly OpencodeSettingField[];
  /** Current field map; null = whole key absent (every field 未设置). */
  value: ShallowObjectValue | null;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /**
   * Partial-commit mode for shared-parent descriptors (agent 扩展): every commit
   * posts a single-field edit map instead of the full-map snapshot.
   */
  partialCommit?: boolean;
  /** Commit the field map (nulls mark unset fields on full-map rows). */
  onChange(next: ShallowObjectValue): void;
}) {
  // Per-field draft text and inline errors — local state; drafts die with the blur commit.
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  /** Drop one field's local draft + error (the shared tail of every commit path). */
  const clearFieldState = (fieldKey: string) => {
    setErrors((current) => {
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
  };

  /** The map one leaf commit posts: single-field (partial rows) or the full snapshot. */
  const nextMap = (field: OpencodeSettingField, leaf: ShallowObjectValue[string]): ShallowObjectValue => {
    if (partialCommit === true) {
      return shallowLeafEdit(field.key, leaf);
    }
    const next: ShallowObjectValue = {};
    for (const entry of fields) {
      next[entry.key] = entry.key === field.key ? leaf : (value?.[entry.key] ?? null);
    }
    return next;
  };

  /** Commit one parsed leaf (keep drafts for other fields). */
  const commitLeaf = (field: OpencodeSettingField, leaf: ShallowObjectValue[string]) => {
    clearFieldState(field.key);
    onChange(nextMap(field, leaf));
  };

  /** Commit one number field: invalid keeps the draft + error; noop (non-numeric) keeps the draft silently. */
  const commitNumber = (field: OpencodeSettingField, raw: string) => {
    const parsed = parseNumberFieldInput(raw, field);
    if (parsed.kind === "invalid") {
      setErrors((current) => ({ ...current, [field.key]: parsed.error }));
      return;
    }
    if (parsed.kind === "noop") {
      return;
    }
    commitLeaf(field, parsed.value);
  };

  /** Commit one string field: empty → null (未设置), over-length keeps the draft + error. */
  const commitString = (field: OpencodeSettingField, raw: string) => {
    const parsed = parseShallowStringInput(raw, field);
    if (parsed.kind === "invalid") {
      setErrors((current) => ({ ...current, [field.key]: parsed.error }));
      return;
    }
    commitLeaf(field, parsed.value);
  };

  /** Commit one multiline field (blur path only — Enter is a newline in the textarea). */
  const commitMultiline = (field: OpencodeSettingField, raw: string) => {
    const parsed = parseShallowMultilineInput(raw, field);
    if (parsed.kind === "invalid") {
      setErrors((current) => ({ ...current, [field.key]: parsed.error }));
      return;
    }
    commitLeaf(field, parsed.value);
  };

  /** Text a draft input shows: the in-progress draft ?? the leaf's display form. */
  const draftText = (field: OpencodeSettingField, leaf: ShallowObjectValue[string] | undefined): string => {
    const draft = drafts[field.key];
    if (draft !== undefined) {
      return draft;
    }
    if (field.kind === "number") {
      return typeof leaf === "number" ? String(leaf) : "";
    }
    return typeof leaf === "string" ? leaf : "";
  };

  return (
    <div className="ctl-list ctl-fields">
      {fields.map((field) => {
        const leaf = value?.[field.key] ?? null;
        return (
          <div className={field.kind === "multiline" ? "ctl-row ctl-row-multiline" : "ctl-row"} key={field.key}>
            <span className="ctl-label" title={field.label}>
              {field.label}
            </span>
            {field.kind === "boolean" ? (
              <label className="s-switch">
                <input
                  type="checkbox"
                  className="s-switch-input"
                  aria-label={field.label}
                  checked={effectiveShallowBoolean(value, field)}
                  disabled={disabled}
                  onChange={() => {
                    onChange(nextMap(field, !effectiveShallowBoolean(value, field)));
                  }}
                />
                <span className="s-switch-track" aria-hidden="true" />
              </label>
            ) : field.kind === "enum" ? (
              <select
                className="ctl"
                aria-label={field.label}
                disabled={disabled}
                value={typeof leaf === "string" ? leaf : ""}
                onChange={(e) => {
                  // 未设置 commits a null leaf (remove that field's key); sibling
                  // leaves keep their file values in the full-map snapshot.
                  onChange(nextMap(field, e.target.value === "" ? null : e.target.value));
                }}
              >
                <option value="">未设置</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.kind === "stringList" ? (
              <StringListEditor
                value={Array.isArray(leaf) ? leaf : null}
                disabled={disabled}
                onChange={(next) => commitLeaf(field, next)}
              />
            ) : field.kind === "multiline" ? (
              <textarea
                className="ctl ctl-multiline"
                rows={6}
                aria-label={field.label}
                disabled={disabled}
                value={draftText(field, leaf)}
                onBlur={(e) => commitMultiline(field, e.currentTarget.value)}
                onChange={(e) => {
                  setDrafts((current) => ({ ...current, [field.key]: e.target.value }));
                  setErrors((current) => {
                    const next = { ...current };
                    delete next[field.key];
                    return next;
                  });
                }}
              />
            ) : (
              <input
                className="ctl ctl-num"
                type="text"
                inputMode={field.kind === "number" ? "decimal" : "text"}
                disabled={disabled}
                aria-label={field.label}
                value={draftText(field, leaf)}
                onKeyDown={(e) => {
                  // Enter commits through the single blur path, so a commit can never fire twice.
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                onChange={(e) => {
                  setDrafts((current) => ({ ...current, [field.key]: e.target.value }));
                  setErrors((current) => {
                    const next = { ...current };
                    delete next[field.key];
                    return next;
                  });
                }}
                onBlur={(e) =>
                  field.kind === "number"
                    ? commitNumber(field, e.currentTarget.value)
                    : commitString(field, e.currentTarget.value)
                }
              />
            )}
            {errors[field.key] !== undefined && (
              <span className="ctl-inline-error" role="alert">
                {errors[field.key]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
