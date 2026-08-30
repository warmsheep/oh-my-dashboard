import type { OpencodeSettingField, ShallowObjectValue } from "@shared/protocol";
import { useState } from "react";

import { effectiveShallowBoolean, parseNumberFieldInput } from "./helpers";

/**
 * shallowObject-kind editor: one row per descriptor field. Boolean fields render the
 * shared s-switch showing value ?? field.default ?? false; number fields render a
 * draft text input committing on blur/Enter (empty → null = 未设置, decimals allowed
 * unless field.integer, bounds from the field — invalid input keeps the draft and
 * shows the inline Chinese error); enum fields render a select (未设置 + field
 * options — the read path nulls out-of-option leaves, so every shown value is
 * committable). Every commit sends the FULL field map with nulls for unset fields;
 * the host accepts the whole snapshot.
 */
export default function ShallowObjectFields({
  fields,
  value,
  disabled,
  onChange,
}: {
  /** Field schemas from the descriptor (label / kind / bounds / default). */
  fields: readonly OpencodeSettingField[];
  /** Current field map; null = whole key absent (every field 未设置). */
  value: ShallowObjectValue | null;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the full field map (nulls mark unset fields). */
  onChange(next: ShallowObjectValue): void;
}) {
  // Per-field draft text and inline errors — local state; drafts die with the blur commit.
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  /** Commit one number field onto the full snapshot (keep drafts for other fields). */
  const commitNumber = (field: OpencodeSettingField, raw: string) => {
    const parsed = parseNumberFieldInput(raw, field);
    if (parsed.kind === "invalid") {
      // Keep the draft so the user can fix the text; commit nothing.
      setErrors((current) => ({ ...current, [field.key]: parsed.error }));
      return;
    }
    if (parsed.kind === "noop") {
      // Non-numeric text: keep the draft as-is, commit nothing.
      return;
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[field.key];
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[field.key];
      return next;
    });
    const next: ShallowObjectValue = {};
    for (const entry of fields) {
      next[entry.key] = entry.key === field.key ? parsed.value : (value?.[entry.key] ?? null);
    }
    onChange(next);
  };

  return (
    <div className="ctl-list ctl-fields">
      {fields.map((field) => {
        const leaf = value?.[field.key] ?? null;
        return (
          <div className="ctl-row" key={field.key}>
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
                    const next: ShallowObjectValue = {};
                    for (const entry of fields) {
                      next[entry.key] =
                        entry.key === field.key ? !effectiveShallowBoolean(value, field) : (value?.[entry.key] ?? null);
                    }
                    onChange(next);
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
                  const next: ShallowObjectValue = {};
                  for (const entry of fields) {
                    next[entry.key] =
                      entry.key === field.key
                        ? e.target.value === ""
                          ? null
                          : e.target.value
                        : (value?.[entry.key] ?? null);
                  }
                  onChange(next);
                }}
              >
                <option value="">未设置</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="ctl ctl-num"
                type="text"
                inputMode="decimal"
                disabled={disabled}
                aria-label={field.label}
                value={drafts[field.key] ?? (typeof leaf === "number" ? String(leaf) : "")}
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
                onBlur={(e) => commitNumber(field, e.currentTarget.value)}
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
