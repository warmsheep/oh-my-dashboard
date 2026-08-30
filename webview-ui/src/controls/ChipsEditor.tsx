import { toggleChipValue } from "./helpers";

/**
 * enumChips-kind editor: a fixed-options multi-select rendered with the shared
 * provider-chip styles. The checked set IS the value; an empty selection commits
 * null (remove the key). Pure presentational — validation (options ⊆ descriptor)
 * lives host-side.
 */
export default function ChipsEditor({
  options,
  value,
  disabled,
  onChange,
}: {
  /** Selectable values (descriptor options / KNOWN_AGENTS spread). */
  options: readonly string[];
  /** Currently checked entries; null = key absent (未设置). */
  value: string[] | null;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the next selection (null = empty → remove the key). */
  onChange(next: string[] | null): void;
}) {
  const checked = value ?? [];
  return (
    <div className={`provider-chips${disabled ? " pending" : ""}`}>
      {options.length === 0 ? (
        <span className="set-row-hint">暂无可选项</span>
      ) : (
        options.map((option) => (
          <label key={option} className="provider-chip">
            <input
              type="checkbox"
              aria-label={option}
              checked={checked.includes(option)}
              disabled={disabled}
              onChange={(e) => onChange(toggleChipValue(checked, option, e.currentTarget.checked))}
            />
            <span>{option}</span>
          </label>
        ))
      )}
    </div>
  );
}
