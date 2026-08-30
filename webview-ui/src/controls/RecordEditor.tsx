import type {
  ModelOption,
  RecordEditorValue,
  RecordEntryValue,
  RecordFieldDef,
  RecordFieldValue,
} from "@shared/protocol";
import { useMemo, useState } from "react";

import { groupModelsByProvider } from "../helpers";
import {
  isRecordEditorLeaf,
  isStringMapLeaf,
  parseNumberFieldInput,
  parseRecordTextField,
  planRecordCommit,
  recordBlockedCommitError,
  recordEntryNameError,
  recordFieldMaxLen,
  recordStringListMaxEntries,
  type RecordNameRules,
} from "./helpers";
import StringListEditor from "./StringListEditor";
import StringMapEditor from "./StringMapEditor";

/**
 * recordEditor-kind editor (command / formatter / lsp entries): one row per named
 * entry (name button selects it, 删除 commits a null deletion marker for live names
 * or drops a never-committed draft locally) plus a 新增名称 row and the selected
 * entry's per-field form (text input, multiline textarea, s-switch, stringList,
 * stringMap KEY/VALUE rows, number input, enum / provider-grouped model selects,
 * and "record"-kind fields rendering ONE nested RecordEditor level — e.g. the
 * provider entry's models block). EVERY change commits the FULL snapshot —
 * including null deletion markers, collapsing to null when no live entry remains.
 * Required-field gate: while any LIVE entry leaves a required field empty, no
 * onChange may fire; the change is held in a local working copy (surviving init
 * pushes, cleared with the entry on deletion) until the gap is fixed or the entry
 * deleted, and a red notice names the blocking entry. The mcpEntries descriptor
 * additionally gates on its cross-field rule (remote ⇒ url — see helpers).
 * Field text drafts are local
 * state as well, so pushes never clobber in-progress typing.
 */
export default function RecordEditor({
  fields,
  value,
  disabled,
  modelOptions,
  nameRules,
  settingKey,
  onChange,
}: {
  /** Field schemas from the descriptor (the selected entry's form rows). */
  fields: readonly RecordFieldDef[];
  /** Live entries of the read form (no null markers); null = key absent. */
  value: RecordEditorValue | null;
  /** Pending-write disable shared with the hosting set-row. */
  disabled: boolean;
  /** Provider-grouped model options reused from the hosting tab's payload. */
  modelOptions: readonly ModelOption[];
  /** Name rules from the descriptor's record metadata (defaults: charset /. _-/, 64 chars, 32 entries). */
  nameRules?: RecordNameRules;
  /** Descriptor key — keys the inline mcpEntries remote⇒url cross-field commit gate (core parity). */
  settingKey?: string;
  /** Commit the full snapshot (null = empty → remove the key). */
  onChange(next: RecordEditorValue | null): void;
}) {
  const live = useMemo(
    () => Object.entries(value ?? {}).filter(([, entry]) => entry !== null) as [string, RecordEntryValue][],
    [value],
  );
  const liveNames = useMemo(() => new Set(live.map(([name]) => name)), [live]);
  // Working copies of uncommitted changes: overlays onto live entries (blocked
  // commits) and never-committed draft adds (held until committable).
  const [working, setWorking] = useState<Record<string, RecordEntryValue>>({});
  // In-progress text of text/multiline fields, keyed by entry name then field key.
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [blockedError, setBlockedError] = useState<string | null>(null);

  const draftNames = Object.keys(working).filter((name) => !liveNames.has(name));
  const rowNames = [...live.map(([name]) => name), ...draftNames];
  const active = selected !== null && rowNames.includes(selected) ? selected : null;
  const liveMap = useMemo(() => Object.fromEntries(live) as Record<string, RecordEntryValue>, [live]);

  /** Display content of one entry: the live entry with its held working copy overlaid. */
  const entryOf = (name: string): RecordEntryValue => ({ ...liveMap[name], ...working[name] });

  /** Drop one entry's local state (held copy, text drafts, selection). */
  const clearEntryState = (name: string) => {
    setWorking((current) => {
      if (!(name in current)) {
        return current;
      }
      const next = { ...current };
      delete next[name];
      return next;
    });
    setDrafts((current) => {
      if (!(name in current)) {
        return current;
      }
      const next = { ...current };
      delete next[name];
      return next;
    });
    setSelected((current) => (current === name ? null : current));
  };

  /**
   * Try to commit the full snapshot assembled from `edits` (held overlays + drafts)
   * and one optional live-name deletion. A blocked plan keeps everything local and
   * surfaces the blocking entry; a posted plan drops exactly the working copies the
   * snapshot absorbed (unposted drafts stay held).
   */
  const attemptCommit = (
    edits: Record<string, RecordEntryValue>,
    editedName: string,
    deletedName: string | null,
  ): boolean => {
    const plan = planRecordCommit(fields, value, edits, deletedName, settingKey);
    if (plan.kind === "blocked") {
      setWorking(edits);
      setBlockedError(recordBlockedCommitError(plan.gaps, editedName));
      return false;
    }
    setWorking(() => {
      const retained: Record<string, RecordEntryValue> = {};
      for (const [name, entry] of Object.entries(edits)) {
        if (!plan.postedNames.includes(name)) {
          retained[name] = entry;
        }
      }
      return retained;
    });
    setBlockedError(null);
    onChange(plan.value);
    return true;
  };

  /** Apply one leaf change of entry `name`, committing when the gate allows. */
  const setLeaf = (name: string, field: RecordFieldDef, leaf: RecordFieldValue) => {
    const base = entryOf(name);
    if ((base[field.key] ?? null) === leaf) {
      return;
    }
    attemptCommit({ ...working, [name]: { ...base, [field.key]: leaf } }, name, null);
  };

  /** Blur path of a text/multiline field: parse, then commit or keep the draft. */
  const commitTextField = (name: string, field: RecordFieldDef, raw: string) => {
    const parsed = parseRecordTextField(raw, field);
    if (parsed.kind === "invalid") {
      // Keep the draft so the user can fix the text; the length error stays derived.
      return;
    }
    setDrafts((current) => {
      if (!(name in current) || !(field.key in current[name])) {
        return current;
      }
      // Pure inner copy: updaters must not mutate the state React still owns.
      const next = { ...current, [name]: { ...current[name] } };
      delete next[name][field.key];
      return next;
    });
    setLeaf(name, field, parsed.value);
  };

  /** Blur path of a number field: invalid/noop keeps the draft, else commit the number (null = unset). */
  const commitNumberField = (name: string, field: RecordFieldDef, raw: string) => {
    const parsed = parseNumberFieldInput(raw, field);
    if (parsed.kind !== "commit") {
      // invalid keeps the draft + derived bounds error; noop (non-numeric text) stays held silently.
      return;
    }
    setDrafts((current) => {
      if (!(name in current) || !(field.key in current[name])) {
        return current;
      }
      // Pure inner copy: updaters must not mutate the state React still owns.
      const next = { ...current, [name]: { ...current[name] } };
      delete next[name][field.key];
      return next;
    });
    setLeaf(name, field, parsed.value);
  };

  const addEntry = () => {
    const problem = recordEntryNameError(nameDraft, rowNames, nameRules ?? {});
    if (problem !== null) {
      setNameError(problem);
      return;
    }
    const name = nameDraft.trim();
    setWorking((current) => ({ ...current, [name]: {} }));
    setSelected(name);
    setNameDraft("");
    setNameError(null);
  };

  const deleteEntry = (name: string) => {
    if (!liveNames.has(name)) {
      // Never-committed draft: a purely local removal, nothing to post.
      clearEntryState(name);
      return;
    }
    if (attemptCommit(working, name, name)) {
      clearEntryState(name);
    }
  };

  /** Text a text/multiline/number input shows: the in-progress draft ?? the entry's leaf. */
  const fieldText = (name: string, field: RecordFieldDef): string => {
    const draft = drafts[name]?.[field.key];
    if (draft !== undefined) {
      return draft;
    }
    const leaf = entryOf(name)[field.key];
    if (field.kind === "number") {
      return typeof leaf === "number" ? String(leaf) : "";
    }
    return typeof leaf === "string" ? leaf : "";
  };

  /** Derived inline error of one field: required-empty, over-length draft, or number bounds. */
  const fieldError = (name: string, field: RecordFieldDef): string | null => {
    if (field.required === true && fieldText(name, field).trim() === "") {
      return `${field.label}不能为空`;
    }
    const draft = drafts[name]?.[field.key];
    if (draft === undefined) {
      return null;
    }
    if (field.kind === "number") {
      const parsed = parseNumberFieldInput(draft, field);
      return parsed.kind === "invalid" ? parsed.error : null;
    }
    if (draft.trim().length > recordFieldMaxLen(field)) {
      return `最长 ${recordFieldMaxLen(field)} 个字符`;
    }
    return null;
  };

  const groups = useMemo(() => groupModelsByProvider(modelOptions), [modelOptions]);
  const modelIds = useMemo(() => new Set(modelOptions.map((model) => model.id)), [modelOptions]);

  /** Provider-grouped options; a configured model missing from the catalog stays visible. */
  const renderModelOptions = (current: string) => (
    <>
      {[...groups].map(([provider, opts]) => (
        <optgroup key={provider} label={provider}>
          {opts.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} ({model.id})
            </option>
          ))}
        </optgroup>
      ))}
      {current !== "" && !modelIds.has(current) && <option value={current}>{current}</option>}
    </>
  );

  /** The selected entry's form: one row per RecordFieldDef, laid out per kind. */
  const renderField = (name: string, field: RecordFieldDef) => {
    const leaf = entryOf(name)[field.key] ?? null;
    const wide =
      field.kind === "multiline" ||
      field.kind === "stringList" ||
      field.kind === "stringMap" ||
      field.kind === "record";
    return (
      <div className={wide ? "rec-field rec-field-wide" : "rec-field"} key={field.key}>
        <span className="rec-field-label" title={field.label}>
          {field.label}
          {field.hint !== undefined && <span className="set-row-hint">{field.hint}</span>}
        </span>
        {field.kind === "text" && (
          <input
            className="ctl rec-input"
            type="text"
            aria-label={field.label}
            disabled={disabled}
            value={fieldText(name, field)}
            onKeyDown={(e) => {
              // Enter commits through the single blur path, so a commit can never fire twice.
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => commitTextField(name, field, e.currentTarget.value)}
            onChange={(e) =>
              setDrafts((current) => ({ ...current, [name]: { ...current[name], [field.key]: e.target.value } }))
            }
          />
        )}
        {field.kind === "multiline" && (
          <textarea
            className="ctl rec-multiline"
            rows={6}
            aria-label={field.label}
            disabled={disabled}
            value={fieldText(name, field)}
            onBlur={(e) => commitTextField(name, field, e.currentTarget.value)}
            onChange={(e) =>
              setDrafts((current) => ({ ...current, [name]: { ...current[name], [field.key]: e.target.value } }))
            }
          />
        )}
        {field.kind === "boolean" && (
          <label className="s-switch">
            <input
              type="checkbox"
              className="s-switch-input"
              aria-label={field.label}
              checked={leaf === true}
              disabled={disabled}
              onChange={() => setLeaf(name, field, !(leaf === true))}
            />
            <span className="s-switch-track" aria-hidden="true" />
          </label>
        )}
        {field.kind === "stringList" && (
          <StringListEditor
            value={Array.isArray(leaf) ? leaf : null}
            disabled={disabled}
            maxEntries={recordStringListMaxEntries(field)}
            onChange={(next) => setLeaf(name, field, next)}
          />
        )}
        {field.kind === "number" && (
          <input
            className="ctl rec-input"
            type="text"
            inputMode="decimal"
            aria-label={field.label}
            disabled={disabled}
            value={fieldText(name, field)}
            onKeyDown={(e) => {
              // Enter commits through the single blur path, so a commit can never fire twice.
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => commitNumberField(name, field, e.currentTarget.value)}
            onChange={(e) =>
              setDrafts((current) => ({ ...current, [name]: { ...current[name], [field.key]: e.target.value } }))
            }
          />
        )}
        {field.kind === "stringMap" && (
          <StringMapEditor
            value={leaf !== null && isStringMapLeaf(leaf) ? leaf : null}
            disabled={disabled}
            onChange={(next) => setLeaf(name, field, next)}
          />
        )}
        {field.kind === "record" && (
          <RecordEditor
            fields={field.record?.fields ?? []}
            value={leaf !== null && isRecordEditorLeaf(leaf) ? leaf : null}
            disabled={disabled}
            modelOptions={modelOptions}
            nameRules={field.record}
            onChange={(next) => setLeaf(name, field, next)}
          />
        )}
        {field.kind === "enum" && (
          <select
            className="ctl"
            aria-label={field.label}
            disabled={disabled}
            value={typeof leaf === "string" ? leaf : ""}
            onChange={(e) => setLeaf(name, field, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">未设置</option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
        {field.kind === "model" && (
          <select
            className="ctl"
            aria-label={field.label}
            disabled={disabled}
            value={typeof leaf === "string" ? leaf : ""}
            onChange={(e) => setLeaf(name, field, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">未设置</option>
            {renderModelOptions(typeof leaf === "string" ? leaf : "")}
          </select>
        )}
        {fieldError(name, field) !== null && (
          <span className="ctl-inline-error" role="alert">
            {fieldError(name, field)}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="ctl-list ctl-record">
      {rowNames.length === 0 && <span className="set-row-hint">暂无条目</span>}
      {rowNames.map((name) => (
        <div className={active === name ? "ctl-row rec-row selected" : "ctl-row rec-row"} key={name}>
          <button
            type="button"
            className="rec-name ctl-mono"
            disabled={disabled}
            aria-pressed={active === name}
            onClick={() => setSelected(name)}
            title={name}
          >
            {name}
          </button>
          <button
            type="button"
            className="btn secondary ctl-x"
            disabled={disabled}
            aria-label={`删除条目 ${name}`}
            onClick={() => deleteEntry(name)}
          >
            删除
          </button>
        </div>
      ))}
      <div className="ctl-row ctl-row-add">
        <input
          className="ctl ctl-add"
          type="text"
          placeholder="新增名称后回车"
          aria-label="新增条目名称"
          disabled={disabled}
          value={nameDraft}
          onChange={(e) => {
            setNameDraft(e.target.value);
            setNameError(null);
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
      {nameError !== null && (
        <span className="ctl-inline-error" role="alert">
          {nameError}
        </span>
      )}
      {blockedError !== null && (
        <span className="ctl-inline-error" role="alert">
          {blockedError}
        </span>
      )}
      {active !== null && <div className="rec-form">{fields.map((field) => renderField(active, field))}</div>}
    </div>
  );
}
