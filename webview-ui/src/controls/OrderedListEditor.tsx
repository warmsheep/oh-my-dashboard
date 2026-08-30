import { useState } from "react";

import { moveListEntry, parseOrderedListEntry, removeListEntry } from "./helpers";

/**
 * orderedList-kind editor: ordered rows with ↑/↓ move and 删除 buttons plus a bottom
 * 添加 input committing on Enter/blur. Add-row validation mirrors core's orderedList
 * rules (≤64 unique trimmed entries of ≤64 chars); invalid entries keep the draft and
 * show an inline red hint without committing. Every change commits the FULL ordered
 * array; an empty list commits null (remove the key).
 */
export default function OrderedListEditor({
  value,
  disabled,
  onChange,
}: {
  /** Current entries in their committed order; null = key absent (未设置). */
  value: string[] | null;
  /** Pending-write disable shared with the hosting set-row (freezes every control). */
  disabled: boolean;
  /** Commit the full next array (null = empty → remove the key). */
  onChange(next: string[] | null): void;
}) {
  const entries = value ?? [];
  // Add-row draft + inline validation error — local state, cleared on commit.
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commitDraft = () => {
    const parsed = parseOrderedListEntry(draft, entries);
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
            disabled={disabled || index === 0}
            aria-label={`上移条目 ${entry}`}
            onClick={() => onChange(moveListEntry(entries, index, -1))}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn secondary ctl-x"
            disabled={disabled || index === entries.length - 1}
            aria-label={`下移条目 ${entry}`}
            onClick={() => onChange(moveListEntry(entries, index, 1))}
          >
            ↓
          </button>
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
