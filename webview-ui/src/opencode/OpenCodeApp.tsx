import type {
  ExtToWebview,
  OpencodePermissionState,
  OpencodeRecordStates,
  OpencodeSetting,
  OpencodeSettingsPayload,
  OpencodeSettingValue,
  RecordAggregate,
  RecordEditorValue,
  ShallowObjectValue,
} from "@shared/protocol";
import { isSharedShallowObjectParent, OPENCODE_SETTINGS, OPENCODE_STRING_VALUE_MAX_LENGTH } from "@shared/protocol";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import ChipsEditor from "../controls/ChipsEditor";
import {
  isWideSettingKind,
  parseNumberFieldInput,
  parsePluginListEntry,
  permissionToolEdit,
  recordAggregateAfterCommit,
} from "../controls/helpers";
import type { PermissionAction } from "../controls/helpers";
import OrderedListEditor from "../controls/OrderedListEditor";
import PermissionEditor from "../controls/PermissionEditor";
import RecordEditor from "../controls/RecordEditor";
import RecordGroup from "../controls/RecordGroup";
import ShallowObjectFields from "../controls/ShallowObjectFields";
import StringListEditor from "../controls/StringListEditor";
import { groupModelsByProvider } from "../helpers";
import { mergeIncomingDrafts } from "../settings/helpers";
import { hasVSCodeApi, postToHost } from "../vscode";
import {
  effectiveOpencodeBoolean,
  groupOpencodeSettings,
  parseOpencodeStringInput,
  parseTuiThemeInput,
  recordMasterPairs,
  toggleProviderValue,
  TRISTATE_OPTIONS,
  tristateFromSelectValue,
  tristateToSelectValue,
  uniqueProviderNames,
} from "./helpers";

// Dev-preview fallback so `vite dev` renders the page outside a real webview (mirrors QuotaApp's DEV_SNAPSHOT).
const DEV_PAYLOAD: OpencodeSettingsPayload = {
  values: {
    share: "manual",
    autoupdate: true,
    snapshot: true,
    username: "dev",
    instructions: null,
    pluginEntries: ["@opencontext/amplify", "my-plugin@2.1.0"],
    compaction: { auto: null, prune: null, tail_turns: null, preserve_recent_tokens: null, reserved: null },
    agentBuildTemperature: null,
    agentBuildExtras: {
      prompt: "You are the build agent.",
      hidden: null,
      color: "#3fb950",
      top_p: 0.9,
      "permission.edit": "ask",
      "permission.bash": null,
      "permission.webfetch": null,
      "permission.task": null,
      "permission.doom_loop": null,
      "permission.external_directory": null,
    },
    serverConfig: { port: 4096, hostname: null, mdns: null, mdnsDomain: null, cors: null },
  },
  configPath: "~/.config/opencode/opencode.json",
  models: [
    { id: "opencode/glm-4.7", provider: "opencode", model: "glm-4.7", label: "GLM-4.7" },
    { id: "kimi/kimi-k2", provider: "kimi", model: "kimi-k2", label: "Kimi K2" },
    { id: "deepseek/deepseek-v3", provider: "deepseek", model: "deepseek-v3", label: "DeepSeek V3" },
  ],
  permission: { shorthand: null, tools: {}, advancedTools: [] },
  tui: { theme: null, path: "~/.config/opencode/tui.json" },
  pluginProtected: false,
  records: {
    command: {
      mode: "entries",
      booleanValue: null,
      entries: {
        review: { template: "Review the current diff: $ARGUMENTS", model: "opencode/glm-4.7" },
      },
    },
    formatter: { mode: "unset", booleanValue: null, entries: {} },
    lsp: {
      mode: "entries",
      booleanValue: null,
      entries: { typescript: { extensions: ["ts", "tsx"] } },
    },
    mcp: {
      mode: "entries",
      booleanValue: null,
      entries: {
        memory: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
          environment: { MEMORY_FILE: "" },
          timeout: 5000,
        },
        fetch: {
          type: "remote",
          url: "https://mcp.example.com/fetch",
          enabled: true,
          headers: { Accept: "application/json" },
        },
      },
    },
    provider: {
      mode: "entries",
      booleanValue: null,
      entries: {
        mygw: { name: "My Gateway", "options.baseURL": "https://gw.example.internal/v1", whitelist: ["gw/pro"] },
      },
    },
    references: {
      mode: "entries",
      booleanValue: null,
      entries: {
        docs: { repository: "https://github.com/opencode/docs", branch: "main", description: "opencode docs" },
        localrules: { path: "./docs/rules", hidden: true },
      },
    },
  },
};

/**
 * Pre-edit snapshot of a dedicated payload slot (permission / tui / records) —
 * the revert source on a !ok reply for keys whose display state does NOT live in
 * payload.values. The records variant snapshots only the ONE affected aggregate:
 * reverting a failed formatterEntries write must not clobber an in-flight optimistic
 * lspEntries update in the sibling slots.
 */
type StructuredSnapshot =
  | { slot: "permission"; state: OpencodePermissionState }
  | { slot: "tui"; theme: string | null }
  | { slot: "records"; key: keyof OpencodeRecordStates; aggregate: RecordAggregate };

/** Restore one structured snapshot into the payload (revert path of the structured edits). */
function applyStructuredSnapshot(
  payload: OpencodeSettingsPayload,
  snapshot: StructuredSnapshot,
): OpencodeSettingsPayload {
  switch (snapshot.slot) {
    case "permission":
      return { ...payload, permission: snapshot.state };
    case "tui":
      return { ...payload, tui: { ...payload.tui, theme: snapshot.theme } };
    case "records":
      return { ...payload, records: { ...payload.records, [snapshot.key]: snapshot.aggregate } };
  }
}

/** The records-slot key of a record descriptor (path root; command/formatter/lsp/mcp/provider/references today). */
function recordSlotKey(setting: OpencodeSetting): keyof OpencodeRecordStates {
  return setting.path[0] as keyof OpencodeRecordStates;
}

/**
 * OpenCode tab: visual editor for the high-frequency opencode.json keys declared by
 * OPENCODE_SETTINGS. Every control commits immediately (one opencodeSetSetting post,
 * optimistic with revert on a !ok reply, per-key pending disable and a stale-reply
 * guard — the same contract as the OMO tab's model rows). Scalar kinds patch
 * payload.values; the permission / tui / records faces patch their dedicated payload
 * slots through the structured-edit path below. State comes from opencodeInit pushes
 * only — the tab never requests data.
 */
export default function OpenCodeApp() {
  const [payload, setPayload] = useState<OpencodeSettingsPayload | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});

  // Pre-edit values of keys with an in-flight save — the revert source on a !ok reply.
  const preEditRef = useRef(new Map<string, OpencodeSettingValue>());
  // Same revert source for the dedicated payload slots (permission / tui / records faces).
  const preStructuredRef = useRef(new Map<string, StructuredSnapshot>());
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
        preStructuredRef.current.clear();
        setPending(new Set());
        setError(null);
        // Drafts full-replace too, but the focused input keeps its in-progress text
        // (mergeIncomingDrafts semantics — see settings/SettingsApp).
        setDrafts((current) => mergeIncomingDrafts(current, focusedKeyRef.current));
      } else if (msg.type === "opencodeSettingSaved") {
        const { ok, key } = msg.payload;
        const prev = preEditRef.current.get(key);
        preEditRef.current.delete(key);
        const structured = preStructuredRef.current.get(key);
        preStructuredRef.current.delete(key);
        setPending((current) => {
          if (!current.has(key)) {
            return current;
          }
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        if (!ok) {
          // Revert only when a pre-edit snapshot still exists — an intervening opencodeInit
          // full replace (or the stale-reply guard) already made the push authoritative.
          if (structured !== undefined) {
            setPayload((current) => (current === null ? current : applyStructuredSnapshot(current, structured)));
          } else if (prev !== undefined) {
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
      preStructuredRef.current.clear();
      setPending(new Set());
      setError("保存无响应，请重试");
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [pending]);

  /**
   * Optimistically apply one setting and post it; at most one in-flight save per key.
   * `displayValue` (optional) overrides what the optimistic payload shows while the
   * posted `value` is in flight — used by partial-commit shallowObject rows (agent
   * 扩展), which post a single-field edit map but should keep rendering the sibling
   * leaves' current values until the post-write re-push.
   */
  const applySetting = useCallback(
    (
      setting: OpencodeSetting,
      value: OpencodeSettingValue,
      prev: OpencodeSettingValue,
      displayValue?: OpencodeSettingValue,
    ) => {
      if (preEditRef.current.has(setting.key)) {
        return;
      }
      preEditRef.current.set(setting.key, prev);
      setPending((current) => new Set(current).add(setting.key));
      setError(null);
      setPayload((current) =>
        current === null
          ? current
          : { ...current, values: { ...current.values, [setting.key]: displayValue ?? value } },
      );
      postToHost({ type: "opencodeSetSetting", payload: { key: setting.key, value } });
    },
    [],
  );

  /**
   * Optimistically patch a dedicated payload slot and post the value — the structured
   * twin of applySetting (permission / tui / records faces); same per-key in-flight rule.
   */
  const applyStructured = useCallback(
    (
      key: string,
      value: OpencodeSettingValue,
      snapshot: StructuredSnapshot,
      patch: (current: OpencodeSettingsPayload) => OpencodeSettingsPayload,
    ) => {
      if (preEditRef.current.has(key) || preStructuredRef.current.has(key)) {
        return;
      }
      preStructuredRef.current.set(key, snapshot);
      setPending((current) => new Set(current).add(key));
      setError(null);
      setPayload((current) => (current === null ? current : patch(current)));
      postToHost({ type: "opencodeSetSetting", payload: { key, value } });
    },
    [],
  );

  /**
   * Commit a string-field draft: empty → null (remove key); over-length keeps the draft
   * and shows the length error without posting; no-op when unchanged. The bound is the
   * descriptor maxLen when set (defaultAgent), else the shared string cap.
   */
  const commitString = useCallback(
    (setting: OpencodeSetting, raw: string, prev: OpencodeSettingValue) => {
      // The blur path is the only caller, so focus tracking ends here.
      focusedKeyRef.current = null;
      const parsed = parseOpencodeStringInput(raw, setting.maxLen ?? OPENCODE_STRING_VALUE_MAX_LENGTH);
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

  /**
   * Commit a number-kind draft (agent temperatures, subagent depth): decimals allowed
   * unless the descriptor sets integer, empty → null, out-of-bounds keeps the draft
   * with the descriptor-bounds error.
   */
  const commitNumber = useCallback(
    (setting: OpencodeSetting, raw: string, prev: number | null) => {
      focusedKeyRef.current = null;
      const parsed = parseNumberFieldInput(raw, { min: setting.min, max: setting.max, integer: setting.integer });
      if (parsed.kind === "invalid") {
        setError(parsed.error);
        return;
      }
      if (parsed.kind === "noop") {
        return;
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[setting.key];
        return next;
      });
      if (parsed.value === prev) {
        return;
      }
      applySetting(setting, parsed.value, prev);
    },
    [applySetting],
  );

  /**
   * Commit the tui.json theme draft. parseTuiThemeInput pre-checks the shared
   * TUI_THEME_MAX_LENGTH constant — the exact bound core's isValidTuiTheme
   * enforces, so the friendly error can never drift from the host validator.
   */
  const commitTuiTheme = (raw: string) => {
    focusedKeyRef.current = null;
    const parsed = parseTuiThemeInput(raw);
    if (parsed.kind === "invalid") {
      setError(parsed.error);
      return;
    }
    setDrafts((current) => {
      const next = { ...current };
      delete next.tuiTheme;
      return next;
    });
    const current = payload?.tui.theme ?? null;
    if (parsed.value === current) {
      return;
    }
    applyStructured("tuiTheme", parsed.value, { slot: "tui", theme: current }, (p) => ({
      ...p,
      tui: { ...p.tui, theme: parsed.value },
    }));
  };

  /** Commit the permission global shorthand (null → removes the permission key). */
  const commitPermissionShorthand = (next: PermissionAction | null) => {
    if (payload === null) {
      return;
    }
    applyStructured("permissionShorthand", next, { slot: "permission", state: payload.permission }, (p) => ({
      ...p,
      permission: { shorthand: next, tools: {}, advancedTools: [] },
    }));
  };

  /** Commit ONE tool's action as a single-key map (null removes that tool's key). */
  const commitPermissionTool = (tool: string, next: PermissionAction | null) => {
    if (payload === null) {
      return;
    }
    applyStructured(
      "permissionTools",
      permissionToolEdit(tool, next),
      { slot: "permission", state: payload.permission },
      (p) => {
        const tools = { ...p.permission.tools };
        if (next === null) {
          delete tools[tool];
        } else {
          tools[tool] = next;
        }
        return { ...p, permission: { ...p.permission, tools } };
      },
    );
  };

  /** Commit the FULL entries snapshot of one record path (null deletes / empties the key). */
  const commitRecordEntries = (entriesSetting: OpencodeSetting, next: RecordEditorValue | null) => {
    if (payload === null) {
      return;
    }
    const slotKey = recordSlotKey(entriesSetting);
    applyStructured(
      entriesSetting.key,
      next,
      { slot: "records", key: slotKey, aggregate: payload.records[slotKey] },
      (p) => ({ ...p, records: { ...p.records, [slotKey]: recordAggregateAfterCommit(p.records[slotKey], next) } }),
    );
  };

  /** Commit one record path's master boolean (null = 未设置 → removes the key). */
  const commitRecordMaster = (masterSetting: OpencodeSetting, next: boolean | null) => {
    if (payload === null) {
      return;
    }
    const slotKey = recordSlotKey(masterSetting);
    applyStructured(
      masterSetting.key,
      next,
      { slot: "records", key: slotKey, aggregate: payload.records[slotKey] },
      (p) => ({ ...p, records: { ...p.records, [slotKey]: recordAggregateAfterCommit(p.records[slotKey], next) } }),
    );
  };

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));
  }, []);

  const settingGroups = useMemo(() => groupOpencodeSettings(OPENCODE_SETTINGS), []);
  // recordMaster → its paired recordEditor descriptor (formatter/lsp); the pair's
  // entries row renders inside the RecordGroup, so it is hidden from the row list.
  const recordPairs = useMemo(() => recordMasterPairs(OPENCODE_SETTINGS), []);
  const pairedEntriesKeys = useMemo(
    () => new Set([...recordPairs.values()].map((setting) => setting.key)),
    [recordPairs],
  );
  const modelsByProvider = useMemo(() => groupModelsByProvider(payload?.models ?? []), [payload?.models]);
  const modelIds = useMemo(() => new Set((payload?.models ?? []).map((m) => m.id)), [payload?.models]);
  const providerNames = useMemo(() => uniqueProviderNames(payload?.models ?? []), [payload?.models]);

  /** Narrow an unknown-slot value back to its descriptor kind's shape (reads are display-tolerant). */
  const toStringList = (value: OpencodeSettingValue | undefined): string[] | null =>
    Array.isArray(value) ? value : null;
  const toShallowObject = (value: OpencodeSettingValue | undefined): ShallowObjectValue | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ShallowObjectValue) : null;

  /** The control of one descriptor row (select / switch / input / chips / composite editor). */
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
        if (setting.file === "tui") {
          // The standalone tui.json face: display state lives in payload.tui, not values.
          return (
            <input
              className="ctl oc-text"
              type="text"
              placeholder="示例主题名"
              aria-label={setting.label}
              disabled={isPending}
              value={drafts.tuiTheme ?? payload?.tui.theme ?? ""}
              onFocus={() => {
                focusedKeyRef.current = "tuiTheme";
              }}
              onBlur={(e) => commitTuiTheme(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter commits through the single blur path, so a commit can never fire twice.
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
              onChange={(e) => setDrafts((current) => ({ ...current, tuiTheme: e.target.value }))}
            />
          );
        }
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
      case "number": {
        const leaf = typeof value === "number" ? value : null;
        return (
          <input
            className="ctl ctl-num"
            type="text"
            inputMode="decimal"
            aria-label={setting.label}
            disabled={isPending}
            value={drafts[setting.key] ?? (leaf === null ? "" : String(leaf))}
            onFocus={() => {
              focusedKeyRef.current = setting.key;
            }}
            onBlur={(e) => commitNumber(setting, e.currentTarget.value, leaf)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            onChange={(e) => setDrafts((current) => ({ ...current, [setting.key]: e.target.value }))}
          />
        );
      }
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
                    aria-label={`${setting.label} ${name}`}
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
      case "stringList": {
        const current = toStringList(value);
        return (
          <StringListEditor
            value={current}
            disabled={isPending}
            onChange={(next) => applySetting(setting, next, current ?? null)}
          />
        );
      }
      case "orderedList": {
        // No OpenCode descriptor uses this kind yet (OMO agent_order does) — the kind
        // union is shared, so the renderer stays complete for future descriptors.
        const current = toStringList(value);
        return (
          <OrderedListEditor
            value={current}
            disabled={isPending}
            onChange={(next) => applySetting(setting, next, current ?? null)}
          />
        );
      }
      case "pluginList": {
        // Hand-written [名称, 选项] tuples in the file: read-only notice — the host
        // write gate (PLUGIN_PROTECTED) would reject the whole-array commit anyway.
        if (payload?.pluginProtected) {
          return (
            <span className="set-row-hint" role="note">
              配置包含手写条目（如 [名称, 选项] 元组），请在文件中手动编辑
            </span>
          );
        }
        const current = toStringList(value);
        return (
          <StringListEditor
            value={current}
            disabled={isPending}
            parseEntry={parsePluginListEntry}
            onChange={(next) => applySetting(setting, next, current ?? null)}
          />
        );
      }
      case "enumChips": {
        const current = toStringList(value);
        return (
          <ChipsEditor
            options={setting.options ?? []}
            value={current}
            disabled={isPending}
            onChange={(next) => applySetting(setting, next, current ?? null)}
          />
        );
      }
      case "shallowObject": {
        const current = toShallowObject(value);
        // Shared-parent rows (agent 扩展) commit per-leaf: only the edited field is
        // posted, so sibling leaves the read cannot surface (hand-written permission
        // pattern objects) are never collateral damage; the optimistic display still
        // merges the edit onto the full map until the post-write re-push.
        const partial = isSharedShallowObjectParent(setting);
        return (
          <ShallowObjectFields
            fields={setting.fields ?? []}
            value={current}
            disabled={isPending}
            partialCommit={partial}
            onChange={(next) =>
              applySetting(setting, next, current ?? null, partial ? { ...(current ?? {}), ...next } : undefined)
            }
          />
        );
      }
      case "permissionTools":
        return (
          <PermissionEditor
            state={payload?.permission ?? { shorthand: null, tools: {}, advancedTools: [] }}
            disabled={isPending}
            onShorthandChange={commitPermissionShorthand}
            onToolChange={commitPermissionTool}
          />
        );
      case "recordEditor": {
        // Masterless record path (command / mcp): a standalone entries editor fed
        // from the records slot; the paired paths (formatter/lsp) render inside RecordGroup.
        const slotKey = recordSlotKey(setting);
        const aggregate = payload?.records[slotKey] ?? { mode: "unset" as const, booleanValue: null, entries: {} };
        return (
          <RecordEditor
            fields={setting.record?.fields ?? []}
            value={aggregate.entries}
            disabled={isPending}
            modelOptions={payload?.models ?? []}
            nameRules={setting.record}
            settingKey={setting.key}
            onChange={(next) => commitRecordEntries(setting, next)}
          />
        );
      }
      case "recordMaster": {
        const entriesSetting = recordPairs.get(setting.key);
        if (entriesSetting === undefined) {
          return null;
        }
        const slotKey = recordSlotKey(setting);
        const aggregate = payload?.records[slotKey] ?? { mode: "unset" as const, booleanValue: null, entries: {} };
        return (
          <RecordGroup
            aggregate={aggregate}
            masterDescriptor={setting}
            entriesDescriptor={entriesSetting}
            modelOptions={payload?.models ?? []}
            disabled={isPending}
            onMasterChange={(next) => commitRecordMaster(setting, next)}
            onEntriesChange={(next) => commitRecordEntries(entriesSetting, next)}
          />
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
            // The permissionShorthand descriptor has no row of its own: its 简写 select
            // lives inside PermissionEditor (the permissionTools row right below it).
            // Paired recordEditor rows (formatterEntries/lspEntries) likewise render
            // inside their master's RecordGroup.
            const rendered = group.settings.filter(
              (setting) => setting.key !== "permissionShorthand" && !pairedEntriesKeys.has(setting.key),
            );
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
                  <span className="block-count">{rendered.length} 项</span>
                </button>
                {!isCollapsed && (
                  <div className="block-body">
                    {rendered.map((setting) => (
                      <Fragment key={setting.key}>
                        <div className={isWideSettingKind(setting.kind) ? "set-row set-row-wrap" : "set-row"}>
                          <span className="set-row-main">
                            <span className="set-row-label">{setting.label}</span>
                            {setting.hint !== undefined && <span className="set-row-hint">{setting.hint}</span>}
                          </span>
                          {renderControl(setting, payload.values[setting.key])}
                        </div>
                        {setting.file === "tui" && payload.tui.path !== "" && (
                          <p className="cfg-target tui-file-path">
                            主题文件：
                            <code className="cfg-target-path" title={payload.tui.path}>
                              {payload.tui.path}
                            </code>
                          </p>
                        )}
                      </Fragment>
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
