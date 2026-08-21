import type {
  ExtToWebview,
  PresetRow,
  WebviewInitPayload,
} from "@shared/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SECTIONS, VARIANT_ORDER } from "./constants";
import {
  countConfigured,
  type FormState,
  groupModelsByProvider,
  isDirty,
  type ModelOption,
  mergeRows,
  setAllModels,
  variantFromLabel,
  variantLabel,
} from "./helpers";
import {
  clearDraft,
  hasVSCodeApi,
  loadDraft,
  postToHost,
  saveDraft,
} from "./vscode";

const DEV_INIT_PAYLOAD: WebviewInitPayload = {
  preset: {
    name: "日常开发",
    description: "浏览器预览用的示例数据",
    rows: [
      {
        section: "agents",
        name: "oracle",
        model: "zhipu/glm-4.7",
        variant: "high",
      },
      {
        section: "agents",
        name: "explore",
        model: "zhipu/glm-4.5-air",
        variant: null,
      },
      {
        section: "categories",
        name: "quick",
        model: "zhipu/glm-4.5-air",
        variant: "low",
      },
      {
        section: "categories",
        name: "deep",
        model: "anthropic/claude-sonnet-4.5",
        variant: "xhigh",
      },
    ],
  },
  models: [
    {
      id: "zhipu/glm-4.7",
      provider: "zhipu",
      model: "glm-4.7",
      label: "GLM 4.7",
    },
    {
      id: "zhipu/glm-4.5-air",
      provider: "zhipu",
      model: "glm-4.5-air",
      label: "GLM 4.5 Air",
    },
    {
      id: "zhipu/glm-4.6",
      provider: "zhipu",
      model: "glm-4.6",
      label: "GLM 4.6",
    },
    {
      id: "anthropic/claude-sonnet-4.5",
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
    },
    {
      id: "anthropic/claude-opus-4.6",
      provider: "anthropic",
      model: "claude-opus-4.6",
      label: "Claude Opus 4.6",
    },
    {
      id: "google/gemini-2.5-pro",
      provider: "google",
      model: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
    },
    {
      id: "google/gemini-2.5-flash",
      provider: "google",
      model: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
    },
    {
      id: "openai/gpt-5.2",
      provider: "openai",
      model: "gpt-5.2",
      label: "GPT 5.2",
    },
    {
      id: "openai/o4-mini",
      provider: "openai",
      model: "o4-mini",
      label: "o4 mini",
    },
    {
      id: "moonshotai/kimi-k2.5",
      provider: "moonshotai",
      model: "kimi-k2.5",
      label: "Kimi K2.5",
    },
  ],
};

function toFormState(payload: WebviewInitPayload): FormState {
  return {
    name: payload.preset.name,
    description: payload.preset.description ?? "",
    rows: SECTIONS.flatMap((s) =>
      mergeRows(s.known, payload.preset.rows, s.key),
    ),
  };
}

function ModelSelect({
  models,
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  models: readonly ModelOption[];
  value: string | null;
  disabled: boolean;
  ariaLabel: string;
  onChange: (model: string | null) => void;
}) {
  return (
    <select
      className="ctl sel-model"
      value={value ?? ""}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">（未设置）</option>
      {[...groupModelsByProvider(models)].map(([provider, opts]) => (
        <optgroup key={provider} label={provider}>
          {opts.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function MatrixRow({
  row,
  models,
  disabled,
  onUpdate,
}: {
  row: PresetRow;
  models: readonly ModelOption[];
  disabled: boolean;
  onUpdate: (
    section: PresetRow["section"],
    name: string,
    patch: Partial<Pick<PresetRow, "model" | "variant">>,
  ) => void;
}) {
  return (
    <div className={row.model ? "row" : "row unset"}>
      <span className="row-name" title={row.name}>
        {row.name}
      </span>
      <ModelSelect
        models={models}
        value={row.model}
        disabled={disabled}
        ariaLabel={`${row.name} 模型`}
        onChange={(model) => onUpdate(row.section, row.name, { model })}
      />
      <select
        className="ctl sel-variant"
        value={variantLabel(row.variant)}
        disabled={disabled || row.model === null}
        aria-label={`${row.name} variant`}
        onChange={(e) =>
          onUpdate(row.section, row.name, {
            variant: variantFromLabel(e.target.value),
          })
        }
      >
        <option value="">—</option>
        {VARIANT_ORDER.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
        {row.variant !== null && !VARIANT_ORDER.includes(row.variant) && (
          <option value={row.variant}>{row.variant}</option>
        )}
      </select>
    </div>
  );
}

function SectionBlock({
  meta,
  rows,
  models,
  collapsed,
  disabled,
  onToggle,
  onUpdate,
}: {
  meta: (typeof SECTIONS)[number];
  rows: PresetRow[];
  models: readonly ModelOption[];
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
  onUpdate: (
    section: PresetRow["section"],
    name: string,
    patch: Partial<Pick<PresetRow, "model" | "variant">>,
  ) => void;
}) {
  return (
    <section className="block">
      <button
        type="button"
        className="block-head"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
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
              <MatrixRow
                key={`${r.section}:${r.name}`}
                row={r}
                models={models}
                disabled={disabled}
                onUpdate={onUpdate}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [payload, setPayload] = useState<WebviewInitPayload | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [batchModel, setBatchModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [awaitingResult, setAwaitingResult] = useState(false);
  const [locked, setLocked] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [nameMissing, setNameMissing] = useState(false);

  const origNameRef = useRef("");
  const formRef = useRef<FormState | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const handleInit = useCallback((p: WebviewInitPayload) => {
    const base = toFormState(p);
    const draft = loadDraft();
    origNameRef.current = p.preset.name;
    if (draft && draft.origName === p.preset.name) {
      setForm(draft.form);
      setDraftRestored(true);
    } else {
      setForm(base);
      saveDraft({ origName: p.preset.name, form: base });
    }
    setBaseline(base);
    setPayload(p);
    setAwaitingResult(false);
    setLocked(false);
    setConfirmingCancel(false);
    setError(null);
  }, []);

  const handleResult = useCallback(
    (result: { action: "save" | "apply"; ok: boolean; error?: string }) => {
      setAwaitingResult(false);
      if (!result.ok) {
        setError(result.error ?? "操作失败，请重试");
        return;
      }
      const current = formRef.current;
      if (current) {
        const normalized: FormState = {
          name: current.name.trim(),
          description: current.description.trim(),
          rows: current.rows,
        };
        setForm(normalized);
        setBaseline(normalized);
        saveDraft({ origName: origNameRef.current, form: normalized });
      }
      setError(null);
      if (result.action === "apply") {
        setToast("已保存并应用");
        setLocked(true);
        window.setTimeout(() => setLocked(false), 1400);
      } else {
        setToast("已保存");
      }
    },
    [],
  );

  const handlersRef = useRef({ init: handleInit, result: handleResult });
  useEffect(() => {
    handlersRef.current = { init: handleInit, result: handleResult };
  }, [handleInit, handleResult]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "init") handlersRef.current.init(msg.payload);
      else if (msg.type === "result") handlersRef.current.result(msg.payload);
      else if (msg.type === "modelsUpdated") {
        setPayload((current) => (current ? { ...current, models: msg.payload.models } : current));
      }
    };
    window.addEventListener("message", onMessage);
    postToHost({ type: "ready" });
    if (!hasVSCodeApi()) {
      const t = window.setTimeout(
        () => handlersRef.current.init(DEV_INIT_PAYLOAD),
        60,
      );
      return () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(t);
      };
    }
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const dirty = useMemo(
    () => (form && baseline ? isDirty(baseline, form) : false),
    [form, baseline],
  );

  useEffect(() => {
    if (form) postToHost({ type: "dirty", payload: dirty });
  }, [dirty, form]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!draftRestored) return;
    const t = window.setTimeout(() => setDraftRestored(false), 8000);
    return () => window.clearTimeout(t);
  }, [draftRestored]);

  const patchForm = useCallback((updater: (f: FormState) => FormState) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      saveDraft({ origName: origNameRef.current, form: next });
      return next;
    });
    setDraftRestored(false);
    setError(null);
    setConfirmingCancel(false);
  }, []);

  const updateRow = useCallback(
    (
      section: PresetRow["section"],
      name: string,
      patch: Partial<Pick<PresetRow, "model" | "variant">>,
    ) => {
      patchForm((f) => ({
        ...f,
        rows: f.rows.map((r) =>
          r.section === section && r.name === name ? { ...r, ...patch } : r,
        ),
      }));
    },
    [patchForm],
  );

  const applyBatchModel = useCallback(
    (modelId: string) => {
      if (!modelId) return;
      patchForm((f) => ({ ...f, rows: setAllModels(f.rows, modelId) }));
      setBatchModel("");
    },
    [patchForm],
  );

  const clearAllVariants = useCallback(() => {
    patchForm((f) => ({
      ...f,
      rows: f.rows.map((r) => ({ ...r, variant: null })),
    }));
  }, [patchForm]);

  const save = useCallback((apply: boolean) => {
    const current = formRef.current;
    if (!current) return;
    if (!current.name.trim()) {
      setNameMissing(true);
      setError("预设名称不能为空");
      nameInputRef.current?.focus();
      return;
    }
    setNameMissing(false);
    setError(null);
    setAwaitingResult(true);
    postToHost({
      type: "save",
      payload: {
        name: current.name.trim(),
        description: current.description.trim() || undefined,
        rows: current.rows,
        apply,
      },
    });
  }, []);

  const cancel = useCallback(() => {
    if (dirty) setConfirmingCancel(true);
    else postToHost({ type: "cancel" });
  }, [dirty]);

  const discardAndClose = useCallback(() => {
    clearDraft(formRef.current?.rows ?? []);
    postToHost({ type: "cancel" });
  }, []);

  if (!payload || !form) {
    return <div className="boot">正在加载…</div>;
  }

  const busy = awaitingResult || locked;

  return (
    <form
      className="app"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
    >
      <main className="page">
        <header className="page-head">
          <h1>预设矩阵编辑器</h1>
          <p>
            为各 Agent 与 Category 指定模型和 variant；未设置的行继承默认配置。
          </p>
        </header>

        {draftRestored && <div className="notice">已恢复上次未保存的草稿</div>}
        {error && (
          <div className="banner-error" role="alert">
            <span className="banner-icon" aria-hidden="true">
              ⛔
            </span>
            {error}
          </div>
        )}

        <fieldset className="meta" disabled={busy}>
          <div className="field">
            <label htmlFor="preset-name">
              预设名称
              <i className="req" aria-hidden="true">
                *
              </i>
            </label>
            <input
              id="preset-name"
              ref={nameInputRef}
              className={`ctl${nameMissing ? " invalid" : ""}`}
              value={form.name}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="例如：日常开发"
              onChange={(e) =>
                patchForm((f) => ({ ...f, name: e.target.value }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="preset-desc">描述</label>
            <input
              id="preset-desc"
              className="ctl"
              value={form.description}
              autoComplete="off"
              spellCheck={false}
              placeholder="可选，一句话说明这个预设的用途"
              onChange={(e) =>
                patchForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </div>
        </fieldset>

        <div className="toolbar">
          <span className="toolbar-label">批量</span>
          <select
            className="ctl sel-batch"
            value={batchModel}
            disabled={busy}
            aria-label="全部模型设为"
            onChange={(e) => applyBatchModel(e.target.value)}
          >
            <option value="">全部模型设为…</option>
            {[...groupModelsByProvider(payload.models)].map(
              ([provider, opts]) => (
                <optgroup key={provider} label={provider}>
                  {opts.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} ({m.id})
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={clearAllVariants}
          >
            清除全部 variant
          </button>
        </div>

        <div className="blocks">
          {SECTIONS.map((meta) => (
            <SectionBlock
              key={meta.key}
              meta={meta}
              rows={form.rows.filter((r) => r.section === meta.key)}
              models={payload.models}
              collapsed={collapsed[meta.key] ?? false}
              disabled={busy}
              onToggle={() =>
                setCollapsed((c) => ({
                  ...c,
                  [meta.key]: !(c[meta.key] ?? false),
                }))
              }
              onUpdate={updateRow}
            />
          ))}
        </div>
      </main>

      <footer className="footer">
        {confirmingCancel && (
          <div className="confirm" role="alertdialog" aria-label="确认放弃修改">
            <span className="confirm-text">确认放弃修改？</span>
            <button
              type="button"
              className="btn secondary"
              onClick={discardAndClose}
            >
              放弃
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => setConfirmingCancel(false)}
            >
              继续编辑
            </button>
          </div>
        )}
        <div className="footer-bar">
          <span
            className={`dirty-hint${dirty ? " on" : ""}`}
            aria-live="polite"
          >
            {dirty ? "● 有未保存的修改" : ""}
          </span>
          <div className="actions">
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={cancel}
            >
              取消
            </button>
            <button type="submit" className="btn secondary" disabled={busy}>
              保存
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => save(true)}
            >
              保存并应用
            </button>
          </div>
        </div>
      </footer>

      {toast && (
        <output className="toast" aria-live="polite">
          ✓&ensp;{toast}
        </output>
      )}
    </form>
  );
}
