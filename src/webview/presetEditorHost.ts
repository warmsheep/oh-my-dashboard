import * as vscode from "vscode";

import { PRESET_EDITOR_VIEW_TYPE, presetDraftKey, presetNameError } from "../constants";
import type { ConfigStore } from "../core/configStore";
import { errorMessage } from "../core/errors";
import type { PresetService } from "../core/presetService";
import { KNOWN_AGENTS, KNOWN_CATEGORIES } from "../core/types";
import type { ModelOption, ModelSetting, Preset } from "../core/types";
import type { PresetRow, WebviewInitPayload } from "../shared/protocol";
import { buildWebviewHtml, readWebviewHtml } from "./panelHtml";

export interface PresetEditorDeps {
  configStore: ConfigStore;
  presetService: PresetService;
  refreshAll(): void;
  log(message: string): void;
}

const openPanels = new Map<string, vscode.WebviewPanel>();

/**
 * Push a refreshed model catalog to every open preset editor. Accepts the list
 * itself or a lazy provider; the provider is only invoked when at least one
 * panel is open, so callers avoid computing `listModels()` when nobody listens.
 */
export function notifyPresetEditorsModelsChanged(models: ModelOption[] | (() => ModelOption[])): void {
  if (openPanels.size === 0) {
    return;
  }
  const resolved = typeof models === "function" ? models() : models;
  for (const panel of openPanels.values()) {
    void panel.webview.postMessage({ type: "modelsUpdated", payload: { models: resolved } });
  }
}

/**
 * Test-only bridge for e2e: post a raw protocol message into the open preset
 * editor panel registered under `name` (its CURRENT name key). Returns false
 * when no open panel matches. Gives tests access to the save/apply protocol
 * without exposing the module-private panel map.
 */
export function postMessageToPresetEditor(name: string, message: unknown): boolean {
  const panel = openPanels.get(name);
  if (panel === undefined) {
    return false;
  }
  void panel.webview.postMessage(message);
  return true;
}

/** Open (or reveal) the webview matrix editor for a preset; `name` null means a new unsaved preset. */
export async function openPresetEditor(
  ctx: vscode.ExtensionContext,
  deps: PresetEditorDeps,
  name: string | null,
): Promise<void> {
  let panelKey = name ?? "__new__";
  const existing = openPanels.get(panelKey);
  if (existing) {
    existing.reveal();
    return;
  }

  const html = readWebviewHtml(ctx, "index.html", deps.log);
  if (html === undefined) {
    void vscode.window.showErrorMessage(
      "模板编辑器前端资源缺失（dist-webview/index.html），请先运行 npm run build:webview",
    );
    return;
  }

  const distWebviewUri = vscode.Uri.joinPath(ctx.extensionUri, "dist-webview");
  const panel = vscode.window.createWebviewPanel(
    PRESET_EDITOR_VIEW_TYPE,
    `编辑模板: ${name ?? "新建"}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [distWebviewUri],
    },
  );
  openPanels.set(panelKey, panel);
  ctx.subscriptions.push(panel);

  let currentName: string | null = name;
  let lastInit: WebviewInitPayload | undefined;
  // One workspaceState write per dirty period: the webview sends only the false→true edge,
  // and this guard makes that edge write exactly once until a successful save resets it.
  let dirtySaved = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  let readySettled = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      if (readyTimer !== undefined) {
        clearTimeout(readyTimer);
      }
      fn();
    };
    resolveReady = () => settle(resolve);
    rejectReady = (error: Error) => settle(() => reject(error));
  });
  // A webview that fails to boot (bad bundle, CSP mismatch) must not hang the command.
  readyTimer = setTimeout(() => rejectReady(new Error("模板编辑器初始化超时")), 20_000);

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

  const sendInit = (): void => {
    const draft = ctx.workspaceState.get<WebviewInitPayload>(presetDraftKey(name));
    const payload = isValidInitPayload(draft) ? draft : buildInitPayload();
    lastInit = payload;
    void panel.webview.postMessage({ type: "init", payload });
  };

  const reply = (action: "save" | "apply", ok: boolean, error?: string): void => {
    const payload: { action: "save" | "apply"; ok: boolean; error?: string } = { action, ok };
    if (error !== undefined) {
      payload.error = error;
    }
    void panel.webview.postMessage({ type: "result", payload });
  };

  const handleSave = (message: SavePayload): void => {
    const newName = message.name.trim();
    const action = message.apply ? "apply" : "save";
    const nameError = presetNameError(newName);
    if (nameError !== undefined) {
      reply(action, false, nameError);
      return;
    }
    const original = currentName !== null && deps.presetService.exists(currentName) ? currentName : null;
    if (newName !== original && deps.presetService.exists(newName)) {
      reply(action, false, `模板 ${newName} 已存在`);
      return;
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
    // partial failure leaves this panel keyed under the old name and later
    // reveals open a duplicate editor.
    currentName = newName;
    if (newName !== panelKey) {
      // Re-key so a later editPreset(newName) reuses this panel instead of opening a duplicate.
      openPanels.delete(panelKey);
      openPanels.set(newName, panel);
      panelKey = newName;
    }
    panel.title = `编辑模板: ${newName}`;
    const { agents, categories } = rowsToModelSettings(message.rows);
    const preset: Preset = {
      name: newName,
      ...(message.description !== undefined && message.description !== "" ? { description: message.description } : {}),
      createdAt,
      appliedAt,
      defaults,
      agents,
      categories,
    };
    deps.presetService.save(preset);
    void ctx.workspaceState.update(presetDraftKey(name), undefined);
    dirtySaved = false;
    if (message.apply) {
      try {
        deps.presetService.apply(newName);
      } catch (error) {
        const msg = errorMessage(error);
        deps.log(`presetEditor: 模板已保存为 ${newName}，但应用失败: ${msg}`);
        reply(action, false, `模板已保存${newName !== original ? `为「${newName}」` : ""}，但应用失败：${msg}`);
        deps.refreshAll();
        return;
      }
    }
    deps.refreshAll();
    reply(action, true);
  };

  const listener = panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = parseMessage(raw);
    if (message === undefined) {
      const preview = JSON.stringify(raw) ?? String(raw);
      deps.log(`presetEditor: 忽略无法识别的 webview 消息: ${preview}`);
      // Backstop: a save-typed message that failed validation must still get a
      // reply, or the webview stays busy forever (awaitingResult never clears).
      if (isSaveTyped(raw)) {
        reply(saveActionOf(raw), false, "保存请求格式无法识别");
      }
      return;
    }
    switch (message.kind) {
      case "ready":
        try {
          sendInit();
          resolveReady();
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`presetEditor: 初始化数据装载失败: ${msg}`);
          void panel.webview.postMessage({ type: "initFailed", payload: { error: msg } });
          rejectReady(new Error(msg));
        }
        break;
      case "dirty":
        if (message.dirty && lastInit && !dirtySaved) {
          dirtySaved = true;
          void ctx.workspaceState.update(presetDraftKey(name), lastInit);
        }
        break;
      case "cancel":
        panel.dispose();
        break;
      case "save":
        try {
          handleSave(message.payload);
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`presetEditor: 保存失败: ${msg}`);
          reply(message.payload.apply ? "apply" : "save", false, msg);
        }
        break;
    }
  });

  panel.onDidDispose(() => {
    listener.dispose();
    openPanels.delete(panelKey);
    resolveReady(); // unblock a caller still awaiting the ready handshake
  });

  panel.webview.html = buildWebviewHtml(panel.webview, html, distWebviewUri);
  await ready;
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

interface SavePayload {
  name: string;
  description?: string;
  rows: PresetRow[];
  apply: boolean;
}

type ParsedMessage =
  { kind: "ready" } | { kind: "dirty"; dirty: boolean } | { kind: "cancel" } | { kind: "save"; payload: SavePayload };

/**
 * Validate an incoming webview message against the protocol shape. Returns
 * undefined for anything unrecognized. Module-private — the runtime entry point
 * is the `onDidReceiveMessage` listener.
 */
function parseMessage(raw: unknown): ParsedMessage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
      return { kind: "ready" };
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

function isSaveTyped(raw: unknown): raw is { apply?: unknown } {
  return (
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && (raw as Record<string, unknown>).type === "save"
  );
}

function saveActionOf(raw: { apply?: unknown }): "save" | "apply" {
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
