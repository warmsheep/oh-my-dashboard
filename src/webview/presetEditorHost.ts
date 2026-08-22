import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANTS } from "../core/types";
import type { ModelOption, ModelSetting, Preset, Variant } from "../core/types";
import type { ConfigStore } from "../core/configStore";
import type { PresetService } from "../core/presetService";
import type { PresetRow, WebviewInitPayload } from "../shared/protocol";
import { PRESET_EDITOR_VIEW_TYPE, PRESET_NAME_PATTERN, presetDraftKey } from "../constants";

export interface PresetEditorDeps {
  configStore: ConfigStore;
  presetService: PresetService;
  refreshAll(): void;
  log(message: string): void;
}

const openPanels = new Map<string, vscode.WebviewPanel>();

export function notifyPresetEditorsModelsChanged(models: ModelOption[]): void {
  for (const panel of openPanels.values()) {
    void panel.webview.postMessage({ type: "modelsUpdated", payload: { models } });
  }
}

export async function openPresetEditor(
  ctx: vscode.ExtensionContext,
  deps: PresetEditorDeps,
  name: string | null,
): Promise<void> {
  const panelKey = name ?? "__new__";
  const existing = openPanels.get(panelKey);
  if (existing) {
    existing.reveal();
    return;
  }

  const html = readWebviewHtml(ctx, deps);
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
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

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
    if (!PRESET_NAME_PATTERN.test(newName)) {
      reply(action, false, "模板名须为 1-64 个字符，且不含 / 或 \\");
      return;
    }
    const original =
      currentName !== null && deps.presetService.exists(currentName) ? currentName : null;
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
    deps.presetService.save(preset);
    void ctx.workspaceState.update(presetDraftKey(name), undefined);
    if (message.apply) {
      deps.presetService.apply(newName);
    }
    deps.refreshAll();
    currentName = newName;
    panel.title = `编辑模板: ${newName}`;
    reply(action, true);
  };

  const listener = panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = parseMessage(raw);
    if (message === undefined) {
      const preview = JSON.stringify(raw) ?? String(raw);
      console.warn(`[presetEditor] 忽略无法识别的 webview 消息: ${preview}`);
      deps.log(`presetEditor: 忽略无法识别的 webview 消息: ${preview}`);
      return;
    }
    switch (message.kind) {
      case "ready":
        sendInit();
        resolveReady();
        break;
      case "dirty":
        if (message.dirty && lastInit) {
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
  });

  panel.webview.html = buildHtml(panel, html, distWebviewUri);
  await ready;
}

function buildHtml(
  panel: vscode.WebviewPanel,
  html: string,
  distWebviewUri: vscode.Uri,
): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const jsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distWebviewUri, "index.js"));
  const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distWebviewUri, "main.css"));
  // CSP: no remote origins, no inline scripts; inline styles allowed for VSCode CSS variables.
  const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource};`;
  let out = html.replace(
    /(<script[^>]*?)\ssrc=["'][^"']*\/index\.js["']/i,
    `$1 src="${jsUri}" nonce="${nonce}"`,
  );
  out = out.replace(/(<link[^>]*?)\shref=["'][^"']*\/main\.css["']/i, `$1 href="${cssUri}"`);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>\n    ${meta}`);
  } else {
    out = `${meta}\n${out}`;
  }
  return out;
}

function readWebviewHtml(ctx: vscode.ExtensionContext, deps: PresetEditorDeps): string | undefined {
  const htmlPath = ctx.asAbsolutePath(path.join("dist-webview", "index.html"));
  try {
    return fs.readFileSync(htmlPath, "utf8");
  } catch (error) {
    deps.log(`presetEditor: 无法读取 ${htmlPath}: ${errorMessage(error)}`);
    return undefined;
  }
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
    const keys = new Set<string>([
      ...section.known,
      ...Object.keys(live),
      ...Object.keys(stored),
    ]);
    const extras = [...keys].filter((k) => !section.known.includes(k)).sort();
    for (const name of [...section.known, ...extras]) {
      const setting = stored[name];
      rows.push({
        section: section.key,
        name,
        model: setting ? setting.model : null,
        variant: setting ? setting.variant ?? null : null,
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
  | { kind: "ready" }
  | { kind: "dirty"; dirty: boolean }
  | { kind: "cancel" }
  | { kind: "save"; payload: SavePayload };

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

function isVariantOrNull(value: unknown): value is Variant | null {
  return value === null || (typeof value === "string" && (VARIANTS as readonly string[]).includes(value));
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
  return (
    typeof preset.name === "string" && parseRows(preset.rows) !== undefined && Array.isArray(p.models)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
