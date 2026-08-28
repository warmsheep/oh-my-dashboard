import * as vscode from "vscode";

import { presetDraftKey, presetNameError } from "../constants";
import type { ConfigStore } from "../core/configStore";
import { errorMessage } from "../core/errors";
import type { PresetService } from "../core/presetService";
import { KNOWN_AGENTS, KNOWN_CATEGORIES } from "../core/types";
import type { ModelSetting, Preset } from "../core/types";
import type { PresetRow, WebviewInitPayload } from "../shared/protocol";

export interface PresetEditorDeps {
  configStore: ConfigStore;
  presetService: PresetService;
  refreshAll(): void;
  log(message: string): void;
}

export interface PresetSaveOutcome {
  action: "save" | "apply";
  ok: boolean;
  error?: string;
}

/**
 * ONE preset editing session at a time (the manager panel's 模板 tab). Switching
 * presets = begin() again; unsaved drafts survive per preset through the two
 * draft layers (webview getState per-name slots + workspaceState snapshots).
 */
export interface PresetEditorSession {
  /** Start (or switch) the session for a preset; null = a new unsaved preset.
   *  Returns the init payload (a valid workspaceState draft restores it). Throws
   *  when the preset or model catalog fails to load — caller posts initFailed. */
  begin(name: string | null): WebviewInitPayload;
  /** Handle a save payload from the page; returns the result reply to post. */
  save(payload: SavePayload): PresetSaveOutcome;
  /** Dirty rising edge: persist the open-time init snapshot to workspaceState. */
  noteDirty(): void;
  /** Cancel/discard: clear this session's workspaceState draft. */
  cancel(): void;
}

export function createPresetEditorSession(ctx: vscode.ExtensionContext, deps: PresetEditorDeps): PresetEditorSession {
  /** Preset name the session was opened with (workspaceState draft key). */
  let sessionName: string | null = null;
  /** On-disk identity, tracking renames from successful saves. */
  let currentName: string | null = null;
  let lastInit: WebviewInitPayload | undefined;
  // One workspaceState write per dirty period: the webview sends only the false→true
  // edge, and this guard makes that edge write exactly once until a successful save
  // resets it.
  let dirtySaved = false;

  const buildInitPayload = (): WebviewInitPayload => {
    const assignments = deps.configStore.ohMyAssignments();
    let preset: Preset | null = null;
    if (currentName !== null && deps.presetService.exists(currentName)) {
      try {
        preset = deps.presetService.load(currentName);
      } catch (error) {
        deps.log(`presetEditor: 读取模板 ${currentName} 失败: ${errorMessage(error)}`);
      }
    }
    return {
      preset: {
        name: currentName ?? "",
        ...(preset?.description !== undefined ? { description: preset.description } : {}),
        rows: unionRows(assignments, preset),
      },
      models: deps.configStore.listModels(),
    };
  };

  return {
    begin(name): WebviewInitPayload {
      sessionName = name;
      currentName = name;
      dirtySaved = false;
      const draft = ctx.workspaceState.get<WebviewInitPayload>(presetDraftKey(name));
      const payload = isValidInitPayload(draft) ? draft : buildInitPayload();
      lastInit = payload;
      return payload;
    },
    save(message: SavePayload): PresetSaveOutcome {
      const action = message.apply ? "apply" : "save";
      const newName = message.name.trim();
      const nameError = presetNameError(newName);
      if (nameError !== undefined) {
        return { action, ok: false, error: nameError };
      }
      const original = currentName !== null && deps.presetService.exists(currentName) ? currentName : null;
      if (newName !== original && deps.presetService.exists(newName)) {
        return { action, ok: false, error: `模板 ${newName} 已存在` };
      }
      let createdAt = new Date().toISOString();
      let appliedAt: string | null = null;
      let defaults: Preset["defaults"] = { model: null };
      if (original !== null) {
        const old = deps.presetService.load(original);
        createdAt = old.createdAt;
        appliedAt = old.appliedAt ?? null;
        defaults = old.defaults;
        if (newName !== original) {
          deps.presetService.rename(original, newName);
        }
      }
      // Identity must track the on-disk name BEFORE save/apply can throw, or a
      // partial failure leaves the session editing a preset that no longer exists.
      currentName = newName;
      const { agents, categories } = rowsToModelSettings(message.rows);
      const preset: Preset = {
        name: newName,
        ...(message.description !== undefined && message.description !== ""
          ? { description: message.description }
          : {}),
        createdAt,
        appliedAt,
        defaults,
        agents,
        categories,
      };
      try {
        deps.presetService.save(preset);
        void ctx.workspaceState.update(presetDraftKey(sessionName), undefined);
        dirtySaved = false;
        if (message.apply) {
          try {
            deps.presetService.apply(newName);
          } catch (error) {
            const msg = errorMessage(error);
            deps.log(`presetEditor: 模板已保存为 ${newName}，但应用失败: ${msg}`);
            deps.refreshAll();
            return {
              action,
              ok: false,
              error: `模板已保存${newName !== original ? `为「${newName}」` : ""}，但应用失败：${msg}`,
            };
          }
        }
      } catch (error) {
        const msg = errorMessage(error);
        deps.log(`presetEditor: 保存失败: ${msg}`);
        return { action, ok: false, error: msg };
      }
      deps.refreshAll();
      return { action, ok: true };
    },
    noteDirty(): void {
      if (lastInit !== undefined && !dirtySaved) {
        dirtySaved = true;
        void ctx.workspaceState.update(presetDraftKey(sessionName), lastInit);
      }
    },
    cancel(): void {
      void ctx.workspaceState.update(presetDraftKey(sessionName), undefined);
    },
  };
}

function unionRows(
  assignments: { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> },
  preset: Preset | null,
): PresetRow[] {
  const rows: PresetRow[] = [];
  const sections = [
    { key: "agents" as const, known: KNOWN_AGENTS },
    { key: "categories" as const, known: KNOWN_CATEGORIES },
  ];
  for (const section of sections) {
    const live = assignments[section.key];
    const stored = preset ? preset[section.key] : {};
    const keys = new Set<string>([...section.known, ...Object.keys(live), ...Object.keys(stored)]);
    const extras = [...keys].filter((k) => !section.known.includes(k)).sort();
    for (const name of [...section.known, ...extras]) {
      const setting = stored[name];
      rows.push({
        section: section.key,
        name,
        model: setting ? setting.model : null,
        variant: setting ? (setting.variant ?? null) : null,
      });
    }
  }
  return rows;
}

function rowsToModelSettings(rows: PresetRow[]): Pick<Preset, "agents" | "categories"> {
  const agents: Record<string, ModelSetting> = {};
  const categories: Record<string, ModelSetting> = {};
  for (const row of rows) {
    if (row.model === null) {
      continue;
    }
    const target = row.section === "agents" ? agents : categories;
    target[row.name] = { model: row.model, variant: row.variant };
  }
  return { agents, categories };
}

export interface SavePayload {
  name: string;
  description?: string;
  rows: PresetRow[];
  apply: boolean;
}

export type PresetEditorMessage =
  { kind: "dirty"; dirty: boolean } | { kind: "cancel" } | { kind: "save"; payload: SavePayload };

/**
 * Validate an incoming preset-tab webview message against the protocol shape.
 * Returns undefined for anything unrecognized (the manager host logs + applies
 * the save-typed backstop reply).
 */
export function parsePresetEditorMessage(raw: unknown): PresetEditorMessage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "cancel":
      return { kind: "cancel" };
    case "dirty":
      return typeof msg.payload === "boolean" ? { kind: "dirty", dirty: msg.payload } : undefined;
    case "save": {
      const payload = parseSavePayload(msg.payload);
      return payload ? { kind: "save", payload } : undefined;
    }
    default:
      return undefined;
  }
}

export function isSaveTyped(raw: unknown): raw is { apply?: unknown } {
  return (
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && (raw as Record<string, unknown>).type === "save"
  );
}

export function saveActionOf(raw: { apply?: unknown }): "save" | "apply" {
  return raw.apply === true ? "apply" : "save";
}

function parseSavePayload(raw: unknown): SavePayload | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || typeof p.apply !== "boolean") {
    return undefined;
  }
  if (p.description !== undefined && typeof p.description !== "string") {
    return undefined;
  }
  const rows = parseRows(p.rows);
  if (rows === undefined) {
    return undefined;
  }
  return {
    name: p.name,
    ...(p.description !== undefined ? { description: p.description } : {}),
    rows,
    apply: p.apply,
  };
}

function parseRows(raw: unknown): PresetRow[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const rows: PresetRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    const r = item as Record<string, unknown>;
    if (r.section !== "agents" && r.section !== "categories") {
      return undefined;
    }
    if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > 64) {
      return undefined;
    }
    if (r.model !== null && (typeof r.model !== "string" || r.model.length === 0 || r.model.length > 200)) {
      return undefined;
    }
    if (!isVariantOrNull(r.variant)) {
      return undefined;
    }
    rows.push({ section: r.section, name: r.name, model: r.model, variant: r.variant });
  }
  return rows;
}

/**
 * PresetRow.variant is deliberately wider than the classic VARIANTS five —
 * omo accepts harness-native tokens like "off"/"minimal", so any non-empty
 * bounded string passes (length cap mirrors the name caps in parseRows).
 */
function isVariantOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 64);
}

function isValidInitPayload(raw: unknown): raw is WebviewInitPayload {
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.preset !== "object" || p.preset === null) {
    return false;
  }
  const preset = p.preset as Record<string, unknown>;
  return typeof preset.name === "string" && parseRows(preset.rows) !== undefined && Array.isArray(p.models);
}
