import type { NumberMapValue } from "@shared/protocol";
import { useState } from "react";

import type { NumberBoundsSource } from "./helpers";
import {
  identifierKeyError,
  NUMBER_MAP_MAX_ENTRIES,
  numberMapRows,
  parseNumberFieldInput,
  withNumberMapEntry,
  withoutNumberMapEntry,
} from "./helpers";

/**
 * numberMap-kind editor (并发上限 / 温度覆写): one row per live entry (key label +
 * number input committing on blur/Enter + 删除) plus a bottom add-row. Fixed-options
 * descriptors pick the new key from a select of unused options; free-key descriptors
 * type it (identifier-charset pre-check with the inline red hint). ANY change
 * commits the FULL map snapshot — deletion of a file-existing entry is a null
 * marker; a flat map with no live entries collapses to null (remove the whole
 * key), a nested leaf map never does (null = 无编辑, never wipes the shared
 * agents/categories block). Number drafts are local state keyed by entry, so
 * configInit pushes never clobber in-progress typing.
 */
export default function NumberMapEditor({
  value,
  options,
  bounds,
  wholeKeyRemove,
  disabled,
  onChange,
}: {
  /** Current map; null = key absent, null entries = pending deletions (not rendered). */
  value: NumberMapValue | null;
  /** Fixed key choices (descriptor options); undefined = free-key input mode. */
  options: readonly string[] | undefined;
  /** Descriptor bounds (min/max) reused by the per-entry number pre-check. */
  bounds: NumberBoundsSource;
  /** Flat maps may collapse to null (remove the whole key); nested leaf maps never. */
  wholeKeyRemove: boolean;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the full map snapshot (null = empty flat map → remove the key). */
  onChange(next: NumberMapValue | null): void;
}) {
  const rows = numberMapRows(value);
  const availableOptions = options?.filter((option) => !rows.some((row) => row.key === option));
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const [keyDraft, setKeyDraft] = useState("");
  const [numDraft, setNumDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** Derived inline error of one row's held draft (none once committed/cleared). */
  const errorOf = (key: string): string | null => {
    const draft = drafts[key];
    if (draft === undefined) {
      return null;
    }
    const parsed = parseNumberFieldInput(draft, bounds);
    return parsed.kind === "invalid" ? parsed.error : null;
  };

  /** Blur / Enter path: parse, then set, clear or no-op that entry. */
  const commit = (key: string, raw: string) => {
    const parsed = parseNumberFieldInput(raw, bounds);
    if (parsed.kind !== "commit") {
      // invalid keeps the draft + derived bounds error; noop (non-numeric text) stays held too.
      return;
    }
    setDrafts((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    const live = value?.[key];
    if (parsed.value === null) {
      if (live !== undefined && live !== null) {
        onChange(withoutNumberMapEntry(value, key, wholeKeyRemove));
      }
    } else if (live !== parsed.value) {
      onChange(withNumberMapEntry(value, key, parsed.value));
    }
  };

  const addEntry = () => {
    const existingKeys = rows.map((row) => row.key);
    const keyProblem =
      options !== undefined
        ? keyDraft === ""
          ? "请选择键名"
          : null
        : identifierKeyError(keyDraft, existingKeys, "键名", NUMBER_MAP_MAX_ENTRIES);
    if (keyProblem !== null) {
      setError(keyProblem);
      return;
    }
    const parsed = parseNumberFieldInput(numDraft, bounds);
    const entry = parsed.kind === "commit" ? parsed.value : null;
    if (entry === null) {
      setError(parsed.kind === "invalid" ? parsed.error : "请输入数值");
      return;
    }
    onChange(withNumberMapEntry(value, keyDraft.trim(), entry));
    setKeyDraft("");
    setNumDraft("");
    setError(null);
  };

  return (
    <div className="ctl-list ctl-nummap">
      {rows.length === 0 && <span className="set-row-hint">未设置条目</span>}
      {rows.map((row) => (
        <div className="ctl-row" key={row.key}>
          <span className="ctl-text ctl-alias" title={row.key}>
            {row.key}
          </span>
          <input
            className="ctl ctl-num"
            type="number"
            step="any"
            disabled={disabled}
            aria-label={`条目 ${row.key} 的数值`}
            value={drafts[row.key] ?? String(row.value)}
            onBlur={(e) => commit(row.key, e.currentTarget.value)}
            onKeyDown={(e) => {
              // Enter commits through the single blur path, so a commit can never fire twice.
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onChange={(e) => setDrafts((current) => ({ ...current, [row.key]: e.target.value }))}
          />
          <button
            type="button"
            className="btn secondary ctl-x"
            disabled={disabled}
            aria-label={`删除条目 ${row.key}`}
            onClick={() => onChange(withoutNumberMapEntry(value, row.key, wholeKeyRemove))}
          >
            删除
          </button>
          {errorOf(row.key) !== null && (
            <span className="ctl-inline-error" role="alert">
              {errorOf(row.key)}
            </span>
          )}
        </div>
      ))}
      <div className="ctl-row ctl-row-add">
        {options === undefined ? (
          <input
            className="ctl ctl-add"
            type="text"
            placeholder="新键名"
            aria-label="新增键名"
            disabled={disabled}
            value={keyDraft}
            onChange={(e) => {
              setKeyDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                addEntry();
              }
            }}
          />
        ) : (
          <select
            className="ctl ctl-add"
            aria-label="新增键名"
            disabled={disabled}
            value={keyDraft}
            onChange={(e) => {
              setKeyDraft(e.target.value);
              setError(null);
            }}
          >
            <option value="">选择键名</option>
            {(availableOptions ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
        <input
          className="ctl ctl-num"
          type="number"
          step="any"
          placeholder="数值"
          aria-label="新增键名的数值"
          disabled={disabled}
          value={numDraft}
          onChange={(e) => {
            setNumDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              addEntry();
            }
          }}
        />
        <button type="button" className="btn secondary ctl-x" disabled={disabled} onClick={addEntry}>
          添加
        </button>
      </div>
      {error !== null && (
        <span className="ctl-inline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
