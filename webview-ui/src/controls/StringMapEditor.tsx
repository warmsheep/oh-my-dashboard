import type { StringMapValue } from "@shared/protocol";
import { useState } from "react";

import { parseStringMapEntry, STRING_MAP_VALUE_MAX_LENGTH, withoutStringMapEntry, withStringMapEntry } from "./helpers";

/**
 * stringMap-field editor (recordEditor environment/headers): one row per live
 * KEY/VALUE entry (key label + value input committing on blur/Enter + 删除)
 * plus a bottom key+value add-row. Invalid input (empty/over-long/duplicate key,
 * entry cap, over-long value) keeps the draft and shows an inline red hint
 * without committing; empty VALUES are legal (env FOO=""). ANY change commits
 * the FULL map snapshot — deletion of a file-existing key is a null marker, and
 * the map never collapses to a whole null (pending markers must reach the host).
 * Value drafts are local state keyed by entry, so pushes never clobber typing.
 */
export default function StringMapEditor({
  value,
  disabled,
  onChange,
}: {
  /** Current KEY → value map; null = field unset, null entries = pending deletions (not rendered). */
  value: StringMapValue | null;
  /** Pending-write disable shared with the hosting record form. */
  disabled: boolean;
  /** Commit the full map snapshot. */
  onChange(next: StringMapValue): void;
}) {
  const rows = Object.entries(value ?? {}).filter(([, entry]) => entry !== null) as [string, string][];
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** Derived inline error of one row's held draft (none once committed/cleared). */
  const errorOf = (key: string): string | null => {
    const draft = drafts[key];
    return draft !== undefined && draft.length > STRING_MAP_VALUE_MAX_LENGTH
      ? `值最长 ${STRING_MAP_VALUE_MAX_LENGTH} 个字符`
      : null;
  };

  /** Blur / Enter path of one row's value: bound-check, then upsert or keep the draft. */
  const commitValue = (key: string, raw: string) => {
    if (raw.length > STRING_MAP_VALUE_MAX_LENGTH) {
      return; // keep the draft so the user can fix it; the length error stays derived
    }
    setDrafts((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    if ((value?.[key] ?? null) !== raw) {
      onChange(withStringMapEntry(value, key, raw));
    }
  };

  const addEntry = () => {
    const parsed = parseStringMapEntry(keyDraft, valueDraft, Object.keys(value ?? {}));
    if (parsed.kind === "invalid") {
      setError(parsed.error);
      return;
    }
    onChange(withStringMapEntry(value, parsed.key, parsed.value));
    setKeyDraft("");
    setValueDraft("");
    setError(null);
  };

  return (
    <div className="ctl-list ctl-strmap">
      {rows.length === 0 && <span className="set-row-hint">未设置条目</span>}
      {rows.map(([key, entry]) => (
        <div className="ctl-row" key={key}>
          <span className="ctl-text ctl-alias" title={key}>
            {key}
          </span>
          <input
            className="ctl"
            type="text"
            aria-label={`条目 ${key} 的值`}
            disabled={disabled}
            value={drafts[key] ?? entry}
            onKeyDown={(e) => {
              // Enter commits through the single blur path, so a commit can never fire twice.
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => commitValue(key, e.currentTarget.value)}
            onChange={(e) => setDrafts((current) => ({ ...current, [key]: e.target.value }))}
          />
          <button
            type="button"
            className="btn secondary ctl-x"
            disabled={disabled}
            aria-label={`删除条目 ${key}`}
            onClick={() => onChange(withoutStringMapEntry(value, key))}
          >
            删除
          </button>
          {errorOf(key) !== null && (
            <span className="ctl-inline-error" role="alert">
              {errorOf(key)}
            </span>
          )}
        </div>
      ))}
      <div className="ctl-row ctl-row-add">
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
        <input
          className="ctl"
          type="text"
          placeholder="值（可留空）"
          aria-label="新增键名的值"
          disabled={disabled}
          value={valueDraft}
          onChange={(e) => {
            setValueDraft(e.target.value);
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
