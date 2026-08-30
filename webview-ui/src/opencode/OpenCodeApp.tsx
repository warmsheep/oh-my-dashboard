import type { ExtToWebview, OpencodeSetting, OpencodeSettingsPayload, OpencodeSettingValue } from "@shared/protocol";
import { OPENCODE_SETTINGS } from "@shared/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { groupModelsByProvider } from "../helpers";
import { mergeIncomingDrafts } from "../settings/helpers";
import { hasVSCodeApi, postToHost } from "../vscode";
import {
  effectiveOpencodeBoolean,
  groupOpencodeSettings,
  parseOpencodeStringInput,
  toggleProviderValue,
  TRISTATE_OPTIONS,
  tristateFromSelectValue,
  tristateToSelectValue,
  uniqueProviderNames,
} from "./helpers";

// Dev-preview fallback so `vite dev` renders the page outside a real webview (mirrors QuotaApp's DEV_SNAPSHOT).
const DEV_PAYLOAD: OpencodeSettingsPayload = {
  values: { share: "manual", autoupdate: true, snapshot: true, username: "dev" },
  configPath: "~/.config/opencode/opencode.json",
  models: [
    { id: "opencode/glm-4.7", provider: "opencode", model: "glm-4.7", label: "GLM-4.7" },
    { id: "kimi/kimi-k2", provider: "kimi", model: "kimi-k2", label: "Kimi K2" },
    { id: "deepseek/deepseek-v3", provider: "deepseek", model: "deepseek-v3", label: "DeepSeek V3" },
  ],
};

/**
 * OpenCode tab: visual editor for the high-frequency opencode.json keys declared by
 * OPENCODE_SETTINGS. Every control commits immediately (one opencodeSetSetting post,
 * optimistic with revert on a !ok reply, per-key pending disable and a stale-reply
 * guard — the same contract as the OMO tab's model rows). State comes from
 * opencodeInit pushes only — the tab never requests data.
 */
export default function OpenCodeApp() {
  const [payload, setPayload] = useState<OpencodeSettingsPayload | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});

  // Pre-edit values of keys with an in-flight save — the revert source on a !ok reply.
  const preEditRef = useRef(new Map<string, OpencodeSettingValue>());
  // Key of the focused text input — opencodeInit pushes must never clobber its draft.
  const focusedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "opencodeInit") {
        // Full replace: the pushed payload is the source of truth and supersedes
        // any in-flight optimistic edit (its own saved reply settles the key).
        setPayload(msg.payload);
        preEditRef.current.clear();
        setPending(new Set());
        setError(null);
        // Drafts full-replace too, but the focused input keeps its in-progress text
        // (mergeIncomingDrafts semantics — see settings/SettingsApp).
        setDrafts((current) => mergeIncomingDrafts(current, focusedKeyRef.current));
      } else if (msg.type === "opencodeSettingSaved") {
        const { ok, key } = msg.payload;
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
          // Revert only when the pre-edit value still exists — an intervening opencodeInit
          // full replace (or the stale-reply guard) already made the push authoritative.
          if (prev !== undefined) {
            setPayload((current) =>
              current === null ? current : { ...current, values: { ...current.values, [key]: prev ?? null } },
            );
          }
          setError(msg.payload.error ?? "保存失败，请重试");
        }
      }
    };
    window.addEventListener("message", onMessage);
    if (!hasVSCodeApi()) {
      const t = window.setTimeout(() => setPayload(DEV_PAYLOAD), 60);
      return () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(t);
      };
    }
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Stale-reply guard (mirror of the OMO tab's model rows): a lost host reply must
  // not leave a control disabled forever.
  useEffect(() => {
    if (pending.size === 0) {
      return;
    }
    const t = window.setTimeout(() => {
      preEditRef.current.clear();
      setPending(new Set());
      setError("保存无响应，请重试");
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [pending]);

  /** Optimistically apply one setting and post it; at most one in-flight save per key. */
  const applySetting = useCallback(
    (setting: OpencodeSetting, value: OpencodeSettingValue, prev: OpencodeSettingValue) => {
      if (preEditRef.current.has(setting.key)) {
        return;
      }
      preEditRef.current.set(setting.key, prev);
      setPending((current) => new Set(current).add(setting.key));
      setError(null);
      setPayload((current) =>
        current === null ? current : { ...current, values: { ...current.values, [setting.key]: value } },
      );
      postToHost({ type: "opencodeSetSetting", payload: { key: setting.key, value } });
    },
    [],
  );

  /**
   * Commit a string-field draft: empty → null (remove key); over-length keeps the draft
   * and shows the length error without posting; no-op when unchanged.
   */
  const commitString = useCallback(
    (setting: OpencodeSetting, raw: string, prev: OpencodeSettingValue) => {
      // The blur path is the only caller, so focus tracking ends here.
      focusedKeyRef.current = null;
      const parsed = parseOpencodeStringInput(raw);
      if (parsed.kind === "invalid") {
        // Keep the draft so the user can fix the text; post nothing.
        setError(parsed.error);
        return;
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[setting.key];
        return next;
      });
      const value = parsed.value;
      if (value === (typeof prev === "string" ? prev : null)) {
        return;
      }
      applySetting(setting, value, typeof prev === "string" ? prev : null);
    },
    [applySetting],
  );

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));
  }, []);

  const settingGroups = useMemo(() => groupOpencodeSettings(OPENCODE_SETTINGS), []);
  const modelsByProvider = useMemo(() => groupModelsByProvider(payload?.models ?? []), [payload?.models]);
  const modelIds = useMemo(() => new Set((payload?.models ?? []).map((m) => m.id)), [payload?.models]);
  const providerNames = useMemo(() => uniqueProviderNames(payload?.models ?? []), [payload?.models]);

  /** The control of one descriptor row (select / switch / input / provider chips). */
  const renderControl = (setting: OpencodeSetting, value: OpencodeSettingValue | undefined) => {
    const isPending = pending.has(setting.key);
    switch (setting.kind) {
      case "model":
        return (
          <select
            className="ctl"
            aria-label={setting.label}
            disabled={isPending}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => {
              // Normalize both sides so choosing 未设置 on an already-unset key is a no-op.
              const next = e.target.value;
              const normalized = next === "" ? null : next;
              if (normalized === (value ?? null)) {
                return;
              }
              applySetting(setting, normalized, value ?? null);
            }}
          >
            <option value="">未设置</option>
            {[...modelsByProvider].map(([provider, opts]) => (
              <optgroup key={provider} label={provider}>
                {opts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id})
                  </option>
                ))}
              </optgroup>
            ))}
            {/* A configured model missing from the catalog stays visible/switchable. */}
            {typeof value === "string" && value !== "" && !modelIds.has(value) && (
              <option value={value}>{value}</option>
            )}
          </select>
        );
      case "enum":
        return (
          <select
            className="ctl"
            aria-label={setting.label}
            disabled={isPending}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => {
              // Normalize both sides so choosing 未设置 on an already-unset key is a no-op.
              const next = e.target.value;
              const normalized = next === "" ? null : next;
              if (normalized === (value ?? null)) {
                return;
              }
              applySetting(setting, normalized, value ?? null);
            }}
          >
            <option value="">未设置</option>
            {(setting.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            {/* A hand-edited value outside the documented options stays visible. */}
            {typeof value === "string" && value !== "" && !(setting.options ?? []).includes(value) && (
              <option value={value}>{value}</option>
            )}
          </select>
        );
      case "tristate":
        return (
          <select
            className="ctl"
            aria-label={setting.label}
            disabled={isPending}
            value={tristateToSelectValue(value)}
            onChange={(e) => applySetting(setting, tristateFromSelectValue(e.target.value), value ?? null)}
          >
            <option value="">未设置</option>
            {TRISTATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      case "boolean":
        return (
          <label className="s-switch">
            <input
              type="checkbox"
              className="s-switch-input"
              aria-label={setting.label}
              checked={effectiveOpencodeBoolean(value, setting)}
              disabled={isPending}
              onChange={() => applySetting(setting, !effectiveOpencodeBoolean(value, setting), value ?? null)}
            />
            <span className="s-switch-track" aria-hidden="true" />
          </label>
        );
      case "string":
        return (
          <input
            className="ctl oc-text"
            type="text"
            aria-label={setting.label}
            disabled={isPending}
            value={drafts[setting.key] ?? (typeof value === "string" ? value : "")}
            onFocus={() => {
              focusedKeyRef.current = setting.key;
            }}
            onBlur={(e) => commitString(setting, e.currentTarget.value, value ?? null)}
            onKeyDown={(e) => {
              // Enter commits through the single blur path, so a commit can never fire twice.
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onChange={(e) => setDrafts((current) => ({ ...current, [setting.key]: e.target.value }))}
          />
        );
      case "providers": {
        const current = Array.isArray(value) ? value : [];
        return (
          <div className={`provider-chips${isPending ? " pending" : ""}`}>
            {providerNames.length === 0 ? (
              <span className="set-row-hint">模型清单为空，暂无可选供应商</span>
            ) : (
              providerNames.map((name) => (
                <label key={name} className="provider-chip">
                  <input
                    type="checkbox"
                    aria-label={`禁用供应商 ${name}`}
                    checked={current.includes(name)}
                    disabled={isPending}
                    onChange={(e) => {
                      const next = toggleProviderValue(current, name, e.currentTarget.checked);
                      // An empty array removes the key entirely (back to 未设置).
                      applySetting(setting, next.length === 0 ? null : next, current.length === 0 ? null : current);
                    }}
                  />
                  <span>{name}</span>
                </label>
              ))
            )}
          </div>
        );
      }
    }
  };

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

      {payload === null ? (
        <div className="boot">正在加载…</div>
      ) : (
        <section className="cfg-block" aria-label="opencode 配置">
          <header className="cfg-block-head">
            <h2>opencode 配置</h2>
            <p className="cfg-target">
              配置文件：
              <code className="cfg-target-path" title={payload.configPath}>
                {payload.configPath}
              </code>
            </p>
          </header>
          {settingGroups.map((group) => {
            const key = `opencode:${group.label}`;
            const isCollapsed = collapsed[key] ?? false;
            return (
              <section className="block" key={group.label}>
                <button
                  type="button"
                  className="block-head"
                  onClick={() => toggleCollapsed(key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`chev${isCollapsed ? "" : " open"}`} aria-hidden="true">
                    ▸
                  </span>
                  <span className="block-title">{group.label}</span>
                  <span className="block-count">{group.settings.length} 项</span>
                </button>
                {!isCollapsed && (
                  <div className="block-body">
                    {group.settings.map((setting) => (
                      <div
                        className={setting.kind === "providers" ? "set-row set-row-wrap" : "set-row"}
                        key={setting.key}
                      >
                        <span className="set-row-main">
                          <span className="set-row-label">{setting.label}</span>
                          {setting.hint !== undefined && <span className="set-row-hint">{setting.hint}</span>}
                        </span>
                        {renderControl(setting, payload.values[setting.key])}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </section>
      )}
    </div>
  );
}
