import type {
  ConfigInitPayload,
  ExtToWebview,
  ModelCatalogValue,
  OmoMiscSetting,
  OmoSettingValue,
  PresetRow,
  ShallowObjectValue,
} from "@shared/protocol";
import { OMO_MISC_SETTINGS, OMO_REASONING_LEVELS } from "@shared/protocol";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SECTIONS, VARIANT_ORDER } from "../constants";
import ChipsEditor from "../controls/ChipsEditor";
import { isWideSettingKind } from "../controls/helpers";
import ModelCatalogEditor from "../controls/ModelCatalogEditor";
import ShallowObjectFields from "../controls/ShallowObjectFields";
import StringListEditor from "../controls/StringListEditor";
import { countConfigured, groupModelsByProvider, isKnownVariant, mergeRows, type ModelOption } from "../helpers";
import { mergeIncomingDrafts } from "../settings/helpers";
import { postToHost } from "../vscode";
import { effectiveOmoValue, groupOmoMiscSettings, parseOmoNumberInput, upsertRow } from "./helpers";

/**
 * Pre-init (and dev-preview) state: the host pushes configInit on boot/navigation,
 * so the tab renders clean empty sections until the first payload lands — no fake
 * data, and nothing is posted on mount. All OMO misc keys default to null (unset
 * in file, controls show the descriptor defaults).
 */
const EMPTY_PAYLOAD: ConfigInitPayload = {
  rows: [],
  models: [],
  skills: [],
  target: { kind: "omo", path: "" },
  omo: Object.fromEntries(OMO_MISC_SETTINGS.map((setting) => [setting.key, null])),
};

function rowKey(section: PresetRow["section"], name: string): string {
  return `${section}:${name}`;
}

const ConfigRow = memo(function ConfigRow({
  row,
  groups,
  modelIds,
  pending,
  onChange,
}: {
  row: PresetRow;
  groups: Map<string, ModelOption[]>;
  modelIds: ReadonlySet<string>;
  pending: boolean;
  onChange: (row: PresetRow, patch: { model: string; variant: string | null }) => void;
}) {
  return (
    <div className={row.model ? "row" : "row unset"}>
      <span className="row-name" title={row.name}>
        {row.name}
      </span>
      <select
        className="ctl sel-model"
        value={row.model ?? ""}
        disabled={pending}
        aria-label={`${row.name} 模型`}
        onChange={(e) => {
          const model = e.target.value;
          // The （未设置） placeholder of an unset row is disabled — only real options reach here.
          if (model === "" || model === row.model) {
            return;
          }
          onChange(row, { model, variant: row.variant });
        }}
      >
        {row.model === null && (
          <option value="" disabled>
            （未设置）
          </option>
        )}
        {[...groups].map(([provider, opts]) => (
          <optgroup key={provider} label={provider}>
            {opts.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.id})
              </option>
            ))}
          </optgroup>
        ))}
        {/* A configured model missing from the catalog stays visible/switchable. */}
        {row.model !== null && !modelIds.has(row.model) && <option value={row.model}>{row.model}</option>}
      </select>
      <select
        className="ctl sel-variant"
        value={row.variant ?? ""}
        disabled={pending || row.model === null}
        aria-label={`${row.name} variant`}
        onChange={(e) => {
          // configSetModel requires a non-null model — variant follows the current model.
          if (row.model === null) {
            return;
          }
          onChange(row, { model: row.model, variant: e.target.value === "" ? null : e.target.value });
        }}
      >
        <option value="">不设置</option>
        {VARIANT_ORDER.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
        {row.variant !== null && !isKnownVariant(row.variant) && <option value={row.variant}>{row.variant}</option>}
      </select>
    </div>
  );
});

/** Compact equivalent of the preset editor's SectionBlock (collapsible, 已设置 n/total badge). */
function ModelSection({
  meta,
  rows,
  groups,
  modelIds,
  collapsed,
  pending,
  onToggle,
  onChange,
}: {
  meta: (typeof SECTIONS)[number];
  rows: PresetRow[];
  groups: Map<string, ModelOption[]>;
  modelIds: ReadonlySet<string>;
  collapsed: boolean;
  pending: ReadonlySet<string>;
  onToggle: () => void;
  onChange: (row: PresetRow, patch: { model: string; variant: string | null }) => void;
}) {
  return (
    <section className="block">
      <button type="button" className="block-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={`chev${collapsed ? "" : " open"}`} aria-hidden="true">
          ▸
        </span>
        <span className="block-title">
          {meta.icon}&ensp;{meta.title}
        </span>
        <span className="block-count">
          {countConfigured(rows)}/{rows.length} 已设置
        </span>
      </button>
      {!collapsed && (
        <div className="block-body">
          {rows.length === 0 ? (
            <div className="empty">暂无条目</div>
          ) : (
            rows.map((r) => (
              <ConfigRow
                key={rowKey(r.section, r.name)}
                row={r}
                groups={groups}
                modelIds={modelIds}
                pending={pending.has(rowKey(r.section, r.name))}
                onChange={onChange}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/** Narrow a values-slot entry back to its descriptor kind's shape (reads are display-tolerant). */
function toStringListValue(value: OmoSettingValue | undefined): string[] | null {
  return Array.isArray(value) ? value : null;
}

function toShallowObjectValue(value: OmoSettingValue | undefined): ShallowObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ShallowObjectValue) : null;
}

function toModelCatalogValue(value: OmoSettingValue | undefined): ModelCatalogValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ModelCatalogValue) : null;
}

/**
 * One 功能设置 row: boolean → switch, number → draft-text input committing on
 * blur/Enter, composite kinds → the shared controls/ editors (every change commits
 * the whole descriptor value immediately through onApplyValue).
 */
function OmoSettingRow({
  setting,
  value,
  models,
  pending,
  draft,
  onDraft,
  onToggle,
  onCommit,
  onApplyValue,
  onFocusKey,
}: {
  setting: OmoMiscSetting;
  value: OmoSettingValue | undefined;
  models: readonly ModelOption[];
  pending: boolean;
  draft: string | undefined;
  onDraft(key: string, raw: string): void;
  onToggle(setting: OmoMiscSetting, fileValue: boolean | number | null): void;
  onCommit(setting: OmoMiscSetting, raw: string, fileValue: boolean | number | null): void;
  onApplyValue(setting: OmoMiscSetting, next: OmoSettingValue, prev: OmoSettingValue): void;
  onFocusKey(key: string): void;
}) {
  const hintText =
    setting.kind === "number"
      ? [setting.hint, setting.default !== undefined ? `默认 ${setting.default}` : undefined].filter(Boolean).join("；")
      : (setting.hint ?? "");
  const control = (() => {
    if (setting.kind === "boolean") {
      return (
        <label className="s-switch">
          <input
            type="checkbox"
            className="s-switch-input"
            aria-label={setting.label}
            checked={
              effectiveOmoValue(typeof value === "boolean" || typeof value === "number" ? value : null, setting) ===
              true
            }
            disabled={pending}
            onChange={() => onToggle(setting, typeof value === "boolean" || typeof value === "number" ? value : null)}
          />
          <span className="s-switch-track" aria-hidden="true" />
        </label>
      );
    }
    if (setting.kind === "number") {
      return (
        <input
          className="ctl s-num"
          type="number"
          step={1}
          disabled={pending}
          aria-label={setting.label}
          value={draft ?? (typeof value === "number" ? String(value) : "")}
          onFocus={() => onFocusKey(setting.key)}
          onBlur={(e) => onCommit(setting, e.currentTarget.value, typeof value === "number" ? value : null)}
          onKeyDown={(e) => {
            // Enter commits through the single blur path, so a commit can never fire twice.
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          onChange={(e) => onDraft(setting.key, e.target.value)}
        />
      );
    }
    if (setting.kind === "stringList") {
      const current = toStringListValue(value);
      return (
        <StringListEditor
          value={current}
          disabled={pending}
          onChange={(next) => onApplyValue(setting, next, current ?? null)}
        />
      );
    }
    if (setting.kind === "enumChips") {
      const current = toStringListValue(value);
      return (
        <ChipsEditor
          options={setting.options ?? []}
          value={current}
          disabled={pending}
          onChange={(next) => onApplyValue(setting, next, current ?? null)}
        />
      );
    }
    if (setting.kind === "shallowObject") {
      const current = toShallowObjectValue(value);
      return (
        <ShallowObjectFields
          fields={setting.fields ?? []}
          value={current}
          disabled={pending}
          onChange={(next) => onApplyValue(setting, next, current ?? null)}
        />
      );
    }
    const current = toModelCatalogValue(value);
    return (
      <ModelCatalogEditor
        value={current}
        models={models}
        reasoningLevels={OMO_REASONING_LEVELS}
        disabled={pending}
        onChange={(next) => onApplyValue(setting, next, current ?? null)}
      />
    );
  })();
  return (
    <div className={isWideSettingKind(setting.kind) ? "set-row set-row-wrap" : "set-row"}>
      <span className="set-row-main">
        <span className="set-row-label">{setting.label}</span>
        {hintText !== "" && <span className="set-row-hint">{hintText}</span>}
      </span>
      {control}
    </div>
  );
}

/**
 * OMO tab (原「配置」): the live OMO model assignments (editable, one configSetModel
 * post per row change) plus the 功能设置 section driven by OMO_MISC_SETTINGS
 * descriptors (one omoSetSetting post per toggle/commit; optimistic with revert on
 * a !ok reply). State comes from configInit pushes only — the tab never requests data.
 */
export default function ConfigApp() {
  const [payload, setPayload] = useState<ConfigInitPayload>(EMPTY_PAYLOAD);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [omoDrafts, setOmoDrafts] = useState<Partial<Record<string, string>>>({});

  // Pre-edit values of rows with an in-flight save — the revert source on a !ok reply.
  const preEditRef = useRef(new Map<string, { model: string | null; variant: string | null }>());
  // Same revert source for 功能设置 keys (descriptor-kind file values, incl. composites).
  const preOmoEditRef = useRef(new Map<string, OmoSettingValue>());
  // Key of the focused 功能设置 number input — configInit pushes must never clobber its draft.
  const focusedOmoKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "configInit") {
        // Full replace: the pushed payload is the source of truth and supersedes
        // any in-flight optimistic edit (its own saved reply settles the key).
        setPayload(msg.payload);
        preEditRef.current.clear();
        preOmoEditRef.current.clear();
        setPending(new Set());
        setError(null);
        // Drafts full-replace too, but the focused input keeps its in-progress text
        // (mergeIncomingDrafts semantics — see settings/SettingsApp).
        setOmoDrafts((current) => mergeIncomingDrafts(current, focusedOmoKeyRef.current));
      } else if (msg.type === "configModelSaved") {
        const { ok, section, name } = msg.payload;
        const key = rowKey(section, name);
        const prev = preEditRef.current.get(key);
        preEditRef.current.delete(key);
        setPending((current) => {
          if (!current.has(key)) {
            return current;
          }
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        if (!ok) {
          if (prev) {
            setPayload((current) => ({ ...current, rows: upsertRow(current.rows, section, name, prev) }));
          }
          setError(msg.payload.error ?? "保存失败，请重试");
        }
      } else if (msg.type === "omoSettingSaved") {
        const { ok, key } = msg.payload;
        const prev = preOmoEditRef.current.get(key);
        preOmoEditRef.current.delete(key);
        setPending((current) => {
          if (!current.has(key)) {
            return current;
          }
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        if (!ok) {
          // Revert only when the pre-edit value still exists — an intervening configInit
          // full replace (or the stale-reply guard) already made the push authoritative.
          if (prev !== undefined) {
            setPayload((current) => ({ ...current, omo: { ...current.omo, [key]: prev ?? null } }));
          }
          setError(msg.payload.error ?? "保存失败，请重试");
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Stale-reply guard (mirror of the preset editor's awaitingResult timeout): a lost
  // host reply must not leave a control disabled forever.
  useEffect(() => {
    if (pending.size === 0) {
      return;
    }
    const t = window.setTimeout(() => {
      preEditRef.current.clear();
      preOmoEditRef.current.clear();
      setPending(new Set());
      setError("保存无响应，请重试");
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [pending]);

  /** Optimistically apply a row edit and post it; at most one in-flight save per row. */
  const changeRow = useCallback((row: PresetRow, patch: { model: string; variant: string | null }) => {
    const key = rowKey(row.section, row.name);
    if (preEditRef.current.has(key)) {
      return;
    }
    preEditRef.current.set(key, { model: row.model, variant: row.variant });
    setPending((current) => new Set(current).add(key));
    setError(null);
    setPayload((current) => ({ ...current, rows: upsertRow(current.rows, row.section, row.name, patch) }));
    postToHost({
      type: "configSetModel",
      payload: { section: row.section, name: row.name, model: patch.model, variant: patch.variant },
    });
  }, []);

  /**
   * Optimistically apply one 功能设置 value (any descriptor kind) and post it; at
   * most one in-flight save per key. The scalar toggle/commit paths below funnel
   * into this too — one mechanism, one revert source.
   */
  const applyOmoValue = useCallback((setting: OmoMiscSetting, value: OmoSettingValue, prev: OmoSettingValue) => {
    if (preOmoEditRef.current.has(setting.key)) {
      return;
    }
    preOmoEditRef.current.set(setting.key, prev);
    setPending((current) => new Set(current).add(setting.key));
    setError(null);
    setPayload((current) => ({ ...current, omo: { ...current.omo, [setting.key]: value } }));
    postToHost({ type: "omoSetSetting", payload: { key: setting.key, value } });
  }, []);

  /** Optimistically flip a 功能设置 boolean and post the explicit new value. */
  const toggleOmoSetting = useCallback(
    (setting: OmoMiscSetting, fileValue: boolean | number | null) => {
      const next = !(effectiveOmoValue(fileValue, setting) === true);
      applyOmoValue(setting, next, typeof fileValue === "boolean" ? fileValue : null);
    },
    [applyOmoValue],
  );

  /**
   * Commit a 功能设置 number draft: empty → null (remove key); out-of-bounds keeps the
   * draft and shows the descriptor-bounds error without posting; no-op when unchanged.
   */
  const commitOmoNumber = useCallback(
    (setting: OmoMiscSetting, raw: string, fileValue: boolean | number | null) => {
      // The blur path is the only caller, so focus tracking ends here.
      focusedOmoKeyRef.current = null;
      const parsed = parseOmoNumberInput(raw, setting);
      if (parsed.kind === "invalid") {
        // Keep the draft so the user can fix the text; post nothing.
        setError(parsed.error);
        return;
      }
      setOmoDrafts((current) => {
        const next = { ...current };
        delete next[setting.key];
        return next;
      });
      if (parsed.kind === "noop") {
        return;
      }
      const value = parsed.value;
      const prev = typeof fileValue === "number" ? fileValue : null;
      if (value === prev) {
        return;
      }
      applyOmoValue(setting, value, prev);
    },
    [applyOmoValue],
  );

  /** Mark a 功能设置 number input as focused — its draft survives init pushes. */
  const focusOmoField = useCallback((key: string) => {
    focusedOmoKeyRef.current = key;
  }, []);

  const setOmoDraft = useCallback((key: string, raw: string) => {
    setOmoDrafts((current) => ({ ...current, [key]: raw }));
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));
  }, []);

  const modelsByProvider = useMemo(() => groupModelsByProvider(payload.models), [payload.models]);
  const modelIds = useMemo(() => new Set(payload.models.map((m) => m.id)), [payload.models]);
  const rowsBySection = useMemo(() => {
    const map = new Map<PresetRow["section"], PresetRow[]>();
    for (const meta of SECTIONS) {
      map.set(meta.key, mergeRows(meta.known, payload.rows, meta.key));
    }
    return map;
  }, [payload.rows]);
  const omoGroups = useMemo(() => groupOmoMiscSettings(OMO_MISC_SETTINGS), []);

  const targetLabel = payload.target.kind === "omo" ? "oh-my-openagent" : "legacy";

  return (
    <div className="cfg-tab">
      {error && (
        <div className="banner-error" role="alert">
          <span className="banner-icon" aria-hidden="true">
            ⛔
          </span>
          {error}
        </div>
      )}

      <section className="cfg-block" aria-label="模型配置">
        <header className="cfg-block-head">
          <h2>模型配置</h2>
          <p className="cfg-target">
            写入目标：{targetLabel}
            {payload.target.path !== "" && (
              <code className="cfg-target-path" title={payload.target.path}>
                {payload.target.path}
              </code>
            )}
          </p>
        </header>
        {SECTIONS.map((meta) => (
          <ModelSection
            key={meta.key}
            meta={meta}
            rows={rowsBySection.get(meta.key) ?? []}
            groups={modelsByProvider}
            modelIds={modelIds}
            collapsed={collapsed[meta.key] ?? false}
            pending={pending}
            onToggle={() => toggleCollapsed(meta.key)}
            onChange={changeRow}
          />
        ))}
      </section>

      <section className="cfg-block" aria-label="功能设置">
        <header className="cfg-block-head">
          <h2>功能设置</h2>
          <p className="cfg-target">oh-my-openagent 常用功能开关，即时写入</p>
        </header>
        {omoGroups.map((group) => (
          <section className="block" key={group.label}>
            <button
              type="button"
              className="block-head"
              onClick={() => toggleCollapsed(`omo:${group.label}`)}
              aria-expanded={!(collapsed[`omo:${group.label}`] ?? false)}
            >
              <span className={`chev${collapsed[`omo:${group.label}`] ? "" : " open"}`} aria-hidden="true">
                ▸
              </span>
              <span className="block-title">{group.label}</span>
              <span className="block-count">{group.settings.length} 项</span>
            </button>
            {!(collapsed[`omo:${group.label}`] ?? false) && (
              <div className="block-body">
                {group.settings.map((setting) => (
                  <OmoSettingRow
                    key={setting.key}
                    setting={setting}
                    value={payload.omo[setting.key]}
                    models={payload.models}
                    pending={pending.has(setting.key)}
                    draft={omoDrafts[setting.key]}
                    onDraft={setOmoDraft}
                    onToggle={toggleOmoSetting}
                    onCommit={commitOmoNumber}
                    onApplyValue={applyOmoValue}
                    onFocusKey={focusOmoField}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </section>
    </div>
  );
}
