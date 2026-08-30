import type { ModelCatalogValue, ModelOption } from "@shared/protocol";
import { useMemo, useState } from "react";

import { groupModelsByProvider } from "../helpers";
import { modelAliasError, withCatalogEntry, withoutCatalogAlias } from "./helpers";

/**
 * modelCatalog-kind editor: one row per alias (alias label + model select + reasoning
 * select + 删除) plus a bottom 新增别名 row. ANY change (add / model / reasoning /
 * delete) commits the FULL catalog snapshot — deletion of a file-existing alias is a
 * null marker entry, and a snapshot with no live entries collapses to null (remove
 * the models key). Alias validation (pattern / length / dupes / cap) shows an inline
 * red hint and blocks the add.
 */
export default function ModelCatalogEditor({
  value,
  models,
  reasoningLevels,
  disabled,
  onChange,
}: {
  /** Current catalog; null = key absent, null entries = pending deletions (not rendered). */
  value: ModelCatalogValue | null;
  /** Provider-grouped model options reused from the hosting tab's payload. */
  models: readonly ModelOption[];
  /** Selectable reasoning levels (OMO_REASONING_LEVELS). */
  reasoningLevels: readonly string[];
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Commit the full catalog snapshot (null = empty → remove the key). */
  onChange(next: ModelCatalogValue | null): void;
}) {
  // Live entries only — null markers are deletions already covered by the snapshot.
  const entries = useMemo(
    () =>
      Object.entries(value ?? {}).filter(([, entry]) => entry !== null) as [
        string,
        { model: string; reasoning: string | null },
      ][],
    [value],
  );
  const groups = useMemo(() => groupModelsByProvider(models), [models]);
  const modelIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);

  // 新增别名 row draft + inline alias error — cleared on a successful add.
  const [aliasDraft, setAliasDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addAlias = () => {
    const aliasProblem = modelAliasError(
      aliasDraft,
      entries.map(([alias]) => alias),
    );
    if (aliasProblem !== null) {
      setError(aliasProblem);
      return;
    }
    if (modelDraft === "") {
      setError("请选择模型");
      return;
    }
    onChange(withCatalogEntry(value, aliasDraft.trim(), { model: modelDraft, reasoning: null }));
    setAliasDraft("");
    setModelDraft("");
    setError(null);
  };

  /** Provider-grouped options; a configured model missing from the catalog stays visible. */
  const renderModelOptions = (current: string) => (
    <>
      {[...groups].map(([provider, opts]) => (
        <optgroup key={provider} label={provider}>
          {opts.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </optgroup>
      ))}
      {current !== "" && !modelIds.has(current) && <option value={current}>{current}</option>}
    </>
  );

  return (
    <div className="ctl-list ctl-catalog">
      {entries.length === 0 && <span className="set-row-hint">未设置别名</span>}
      {entries.map(([alias, entry]) => (
        <div className="ctl-row" key={alias}>
          <span className="ctl-text ctl-alias" title={alias}>
            {alias}
          </span>
          <select
            className="ctl sel-model"
            aria-label={`别名 ${alias} 的模型`}
            disabled={disabled}
            value={entry.model}
            onChange={(e) => onChange(withCatalogEntry(value, alias, { ...entry, model: e.target.value }))}
          >
            {renderModelOptions(entry.model)}
          </select>
          <select
            className="ctl sel-variant"
            aria-label={`别名 ${alias} 的 reasoning`}
            disabled={disabled}
            value={entry.reasoning ?? ""}
            onChange={(e) =>
              onChange(
                withCatalogEntry(value, alias, { ...entry, reasoning: e.target.value === "" ? null : e.target.value }),
              )
            }
          >
            <option value="">未设置</option>
            {reasoningLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn secondary ctl-x"
            disabled={disabled}
            aria-label={`删除别名 ${alias}`}
            onClick={() => onChange(withoutCatalogAlias(value, alias))}
          >
            删除
          </button>
        </div>
      ))}
      <div className="ctl-row ctl-row-add">
        <input
          className="ctl ctl-add"
          type="text"
          placeholder="新别名"
          aria-label="新增别名"
          disabled={disabled}
          value={aliasDraft}
          onChange={(e) => {
            setAliasDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Enter commits through the single add path, so a commit can never fire twice.
            if (e.key === "Enter") {
              addAlias();
            }
          }}
        />
        <select
          className="ctl sel-model"
          aria-label="新增别名的模型"
          disabled={disabled}
          value={modelDraft}
          onChange={(e) => {
            setModelDraft(e.target.value);
            setError(null);
          }}
        >
          <option value="">选择模型</option>
          {renderModelOptions("")}
        </select>
        <button type="button" className="btn secondary ctl-x" disabled={disabled} onClick={addAlias}>
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
