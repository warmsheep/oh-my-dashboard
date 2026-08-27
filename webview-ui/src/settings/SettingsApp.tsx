import type { AutoRefreshCategory, AutoRefreshSettings, ExtToWebview } from "@shared/protocol";
import {
  AUTO_REFRESH_CATEGORIES,
  AUTO_REFRESH_MAX_INTERVAL_SECONDS,
  AUTO_REFRESH_MIN_INTERVAL_SECONDS,
  autoRefreshCategoryLabel,
  normalizeAutoRefreshSettings,
  QUOTA_REFRESH_MAX_SECONDS,
  QUOTA_REFRESH_MIN_SECONDS,
} from "@shared/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { hasVSCodeApi, postToHost } from "../vscode";
import type { SettingsFieldKey } from "./helpers";
import {
  buildSettings,
  clampIntervalInput,
  clampQuotaInput,
  isSettingsDirty,
  mergeIncomingDrafts,
  mergeIncomingSettings,
} from "./helpers";

/** Field key of the Coding Plan row (category rows use their own category id). */
const QUOTA_FIELD = "quota" as const;

// Dev-preview fallback so `vite dev` renders the page outside a real webview (mirrors QuotaApp's DEV_SNAPSHOT).
const DEV_SETTINGS: AutoRefreshSettings = normalizeAutoRefreshSettings({
  categories: {
    config: { enabled: true, intervalSeconds: 30 },
    presets: { enabled: true, intervalSeconds: 300 },
    backups: { enabled: false, intervalSeconds: 600 },
    models: { enabled: true, intervalSeconds: 60 },
    plugins: { enabled: false, intervalSeconds: 120 },
  },
  quotaRefreshSeconds: 0,
});

export default function SettingsApp() {
  // saved = last known persisted truth (boot/pushes); form = working copy edited
  // locally. Nothing is written until the user clicks 保存设置.
  const [saved, setSaved] = useState<AutoRefreshSettings | null>(null);
  const [form, setForm] = useState<AutoRefreshSettings | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<SettingsFieldKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Field key of the number input the user is currently editing — external pushes must never clobber it.
  const focusedFieldRef = useRef<SettingsFieldKey | null>(null);
  // The exact payload sent with the in-flight save — settingsSaved(ok) must mark
  // THAT as persisted, not whatever the user edited in the meantime.
  const saveSentRef = useRef<AutoRefreshSettings | null>(null);
  // Mirrors for event handlers (avoid stale closures in the message listener).
  const savedRef = useRef<AutoRefreshSettings | null>(null);
  const formRef = useRef<AutoRefreshSettings | null>(null);

  /** Adopt a settings push (boot, external change): saved always; form only for untouched fields. */
  const adoptSettings = useCallback((incoming: AutoRefreshSettings) => {
    const previousSaved = savedRef.current;
    const previousForm = formRef.current;
    if (previousSaved === null || previousForm === null) {
      savedRef.current = incoming;
      formRef.current = incoming;
      setSaved(incoming);
      setForm(incoming);
    } else {
      const merged = mergeIncomingSettings(incoming, previousSaved, previousForm);
      savedRef.current = merged.saved;
      formRef.current = merged.form;
      setSaved(merged.saved);
      setForm(merged.form);
    }
    setDrafts((previous) => mergeIncomingDrafts(previous, focusedFieldRef.current));
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "settingsInit") {
        adoptSettings(msg.payload.settings);
      } else if (msg.type === "settingsSaved") {
        setSaving(false);
        if (msg.payload.ok) {
          // The persisted truth now equals the payload sent with THIS save; any
          // edits made while it was in flight stay in the form (still dirty).
          const sent = saveSentRef.current;
          if (sent !== null) {
            savedRef.current = sent;
            setSaved(sent);
          }
          saveSentRef.current = null;
          // Drafts mirror committed values after a successful save; the focused
          // field (if any) keeps its raw text untouched.
          setDrafts((previous) => mergeIncomingDrafts(previous, focusedFieldRef.current));
          setSaveError(null);
          setToast("已保存");
        } else {
          setSaveError(msg.payload.error ?? "保存失败，请重试");
        }
      }
    };
    window.addEventListener("message", onMessage);
    if (!hasVSCodeApi()) {
      const t = window.setTimeout(() => adoptSettings(DEV_SETTINGS), 60);
      return () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(t);
      };
    }
    return () => window.removeEventListener("message", onMessage);
  }, [adoptSettings]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  /** Update the working form locally (marks the page dirty); nothing is written until save. */
  const updateForm = useCallback((next: AutoRefreshSettings) => {
    formRef.current = next;
    setForm(next);
    setSaveError(null);
  }, []);

  const handleToggle = useCallback(
    (category: AutoRefreshCategory) => {
      const current = formRef.current;
      if (current === null || saving) {
        return;
      }
      const categories = { ...current.categories };
      categories[category] = { ...categories[category], enabled: !categories[category].enabled };
      updateForm({ ...current, categories });
    },
    [saving, updateForm],
  );

  /** Store the raw text of a number field while typing (commits happen on blur/Enter only). */
  const setDraft = useCallback((field: SettingsFieldKey, value: string) => {
    setDrafts((previous) => {
      const next = { ...previous };
      next[field] = value;
      return next;
    });
  }, []);

  /** Commit a number field into the working form; invalid/empty text keeps the raw draft and changes nothing. */
  const commitField = useCallback(
    (field: SettingsFieldKey, raw: string) => {
      const current = formRef.current;
      if (current === null) {
        return;
      }
      const parsed = field === QUOTA_FIELD ? clampQuotaInput(raw) : clampIntervalInput(raw);
      if (parsed === null) {
        return;
      }
      if (field === QUOTA_FIELD) {
        if (parsed !== current.quotaRefreshSeconds) {
          updateForm({ ...current, quotaRefreshSeconds: parsed });
        }
        setDraft(QUOTA_FIELD, String(parsed));
        return;
      }
      const categories = { ...current.categories };
      if (parsed !== categories[field].intervalSeconds) {
        categories[field] = { ...categories[field], intervalSeconds: parsed };
        updateForm({ ...current, categories });
      }
      setDraft(field, String(parsed));
    },
    [setDraft, updateForm],
  );

  const save = useCallback(() => {
    const current = formRef.current;
    if (current === null || savedRef.current === null || saving) {
      return;
    }
    const payload = buildSettings(current.categories, current.quotaRefreshSeconds);
    saveSentRef.current = payload;
    setSaving(true);
    setSaveError(null);
    postToHost({ type: "settingsSave", payload: { settings: payload } });
  }, [saving]);

  /** Shared number input: raw draft text while editing, commit on blur (Enter routes through the same blur). */
  const renderNumberField = (
    field: SettingsFieldKey,
    value: string,
    min: number,
    max: number,
    ariaLabel: string,
    disabled: boolean,
  ) => (
    <input
      className="ctl s-num"
      type="number"
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      aria-label={ariaLabel}
      value={value}
      onFocus={() => {
        focusedFieldRef.current = field;
      }}
      onBlur={(e) => {
        commitField(field, e.currentTarget.value);
        focusedFieldRef.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          // Enter commits through the single blur path, so a commit can never fire twice.
          e.currentTarget.blur();
        }
      }}
      onChange={(e) => setDraft(field, e.target.value)}
    />
  );

  const dirty = form !== null && saved !== null && isSettingsDirty(form, saved);

  return (
    <div className="stab">
      {saveError && (
        <div className="banner-error" role="alert">
          <span className="banner-icon" aria-hidden="true">
            ⛔
          </span>
          {saveError}
        </div>
      )}

      {form === null ? (
        <div className="boot">正在加载…</div>
      ) : (
        <>
          <section className="s-section">
            <header className="s-section-head">
              <h2>分区自动刷新</h2>
            </header>
            <div className="s-section-body">
              {AUTO_REFRESH_CATEGORIES.map((category) => {
                const categorySetting = form.categories[category];
                return (
                  <div className="s-row" key={category}>
                    <span className="s-row-label">{autoRefreshCategoryLabel(category)}</span>
                    <div className="s-controls">
                      <label className="s-switch">
                        <input
                          type="checkbox"
                          className="s-switch-input"
                          aria-label={`启用${autoRefreshCategoryLabel(category)}自动刷新`}
                          checked={categorySetting.enabled}
                          onChange={() => handleToggle(category)}
                        />
                        <span className="s-switch-track" aria-hidden="true" />
                      </label>
                      <div className={`s-num-group${categorySetting.enabled ? "" : " off"}`}>
                        {renderNumberField(
                          category,
                          drafts[category] ?? String(categorySetting.intervalSeconds),
                          AUTO_REFRESH_MIN_INTERVAL_SECONDS,
                          AUTO_REFRESH_MAX_INTERVAL_SECONDS,
                          `${autoRefreshCategoryLabel(category)}刷新间隔（秒）`,
                          !categorySetting.enabled,
                        )}
                        <span className="s-unit">秒</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="s-section">
            <header className="s-section-head">
              <h2>Coding Plan 额度</h2>
            </header>
            <div className="s-section-body">
              <div className="s-row">
                <span className="s-row-label">刷新频率（秒）</span>
                <div className="s-controls">
                  {renderNumberField(
                    QUOTA_FIELD,
                    drafts[QUOTA_FIELD] ?? String(form.quotaRefreshSeconds),
                    QUOTA_REFRESH_MIN_SECONDS,
                    QUOTA_REFRESH_MAX_SECONDS,
                    "Coding Plan 刷新频率（秒）",
                    false,
                  )}
                </div>
              </div>
              <p className="s-hint">0 = 关闭自动刷新；网络故障时自动退避重试</p>
            </div>
          </section>

          <p className="s-hint s-footnote">开启后按设定间隔轮询刷新树视图；文件变更监听始终生效，手动刷新不受影响。</p>

          <div className="s-footer">
            <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>
              {saving ? "保存中…" : "保存设置"}
            </button>
            {dirty && !saving && <span className="s-dirty-hint">有未保存的更改</span>}
          </div>
        </>
      )}

      {toast && (
        <output className="toast" aria-live="polite">
          ✓&ensp;{toast}
        </output>
      )}
    </div>
  );
}
