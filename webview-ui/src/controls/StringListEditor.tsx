import { useState } from "react";

import type { ListEntryParse } from "./helpers";
import { parseStringListEntry, removeListEntry } from "./helpers";

/**
 * stringList-kind editor: read-only rows with a 删除 button plus a bottom 添加 input
 * committing on Enter/blur. Invalid entries (empty / over-length / duplicate / cap)
 * keep the draft and show an inline red hint without committing. Every change
 * commits the whole list; an empty list commits null (remove the key). Kinds with
 * their own entry rules (pluginList charset) inject them via parseEntry.
 */
export default function StringListEditor({
  value,
  disabled,
  maxEntries,
  parseEntry,
  onChange,
}: {
  /** Current entries; null = key absent (未设置). */
  value: string[] | null;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Add-row entry cap (default 16 — core's STRING_LIST_MAX_ENTRIES; recordEditor fields pass 8). */
  maxEntries?: number;
  /** Add-row commit validation override (pluginList passes its charset-capped mirror; defaults to the stringList rules + maxEntries). */
  parseEntry?: (raw: string, current: readonly string[]) => ListEntryParse;
  /** Commit the next list (null = empty → remove the key). */
  onChange(next: string[] | null): void;
}) {
  const entries = value ?? [];
  // Add-row draft + inline validation error — local state, cleared on commit.
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const validate =
    parseEntry ?? ((raw: string, current: readonly string[]) => parseStringListEntry(raw, current, maxEntries));

  const commitDraft = () => {
    const parsed = validate(draft, entries);
    if (parsed.kind === "invalid") {
      setError(parsed.error);
      return;
    }
    onChange([...entries, parsed.value]);
    setDraft("");
    setError(null);
  };

  return (
    <div className="ctl-list">
      {entries.map((entry, index) => (
        // Index-composite keys: the read path passes hand-written duplicates through, and rows are stateless with full-snapshot commits.
        <div className="ctl-row" key={`${index}~${entry}`}>
          <span className="ctl-text" title={entry}>
            {entry}
          </span>
          <button
            type="button"
            className="btn secondary ctl-x"
            disabled={disabled}
            aria-label={`删除条目 ${entry}`}
            onClick={() => onChange(removeListEntry(entries, index))}
          >
            删除
          </button>
        </div>
      ))}
      <div className="ctl-row ctl-row-add">
        <input
          className="ctl ctl-add"
          type="text"
          placeholder="添加条目后回车"
          aria-label="添加条目"
          disabled={disabled}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Enter commits through the single blur path, so a commit can never fire twice.
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            // Blur with empty text is a plain leave, not an invalid commit.
            if (draft.trim() !== "") {
              commitDraft();
            } else {
              setError(null);
            }
          }}
        />
      </div>
      {error !== null && (
        <span className="ctl-inline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
