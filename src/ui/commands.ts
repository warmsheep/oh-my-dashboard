import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { CMD, FILE_TEMPLATES, MODEL_ID_PATTERN, presetNameError } from "../constants";
import type { BackupService } from "../core/backupService";
import { addLocalModel, LOCAL_MODELS_FILE, removeLocalModel } from "../core/builtinModels";
import type { ConfigStore } from "../core/configStore";
import { errorMessage } from "../core/errors";
import type { PresetService } from "../core/presetService";
import type { BackupEntry, Variant } from "../core/types";
import { BACKUP_REASON_LABELS, KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANTS } from "../core/types";
import { CURRENT_PRESET_BADGE } from "../tree/nodes";
import { openPresetEditor } from "../webview/presetEditorHost";
import {
  agentModelRequestFromArg,
  agentTargetFromArg,
  backupEntryFromArg,
  exportBackupRequestFromArg,
  exportPresetRequestFromArg,
  idSuffix,
  isAllowedExportTarget,
  presetNameFromArg,
  renameBackupRequestFromArg,
  renamePresetRequestFromArg,
  toNode,
} from "./commandArgs";
import type { AgentTarget } from "./commandArgs";

export interface ExtensionDeps {
  configStore: ConfigStore;
  backupService: BackupService;
  presetService: PresetService;
  refreshAll(): void;
  log(message: string): void;
}

/** Programmatic export targets must stay inside these roots (09/R2-P2-1 guard). */
function exportTargetRoots(deps: ExtensionDeps): string[] {
  return [os.homedir(), os.tmpdir(), ...workspaceFolders(), deps.configStore.configDir];
}

/**
 * Roots the raw-string / node.filePath branch of openConfigFile may open from
 * (R1/P2-5): export roots plus the agent config dir (~/.omo or legacy — it can live
 * outside every other root).
 */
function openTargetRoots(deps: ExtensionDeps): string[] {
  return [...exportTargetRoots(deps), path.dirname(deps.configStore.resolveAgentConfig().path)];
}

const EXPORT_TARGET_DENIED = "仅允许导出到用户目录、临时目录或工作区内";
const OPEN_TARGET_DENIED = "仅允许打开用户目录、临时目录、工作区或配置目录内的文件";

const MANUAL_MODEL = "__manual__";

/**
 * Register every `opencode.*` command from CMD on the extension host; each handler is wrapped
 * in run() so failures surface as Chinese notifications. All disposables land in ctx.subscriptions.
 */
export function registerCommands(ctx: vscode.ExtensionContext, deps: ExtensionDeps): void {
  const disposables = [
    vscode.commands.registerCommand(CMD.openConfigFile, (arg?: unknown) =>
      run(deps, "打开配置失败", () => openConfigFile(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.createConfig, (arg?: unknown) =>
      run(deps, "创建配置失败", () => createConfig(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.setAgentModel, (arg?: unknown) =>
      run(deps, "设置模型失败", () => setAgentModel(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.capturePreset, (arg?: unknown) =>
      run(deps, "捕获模板失败", () => capturePreset(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.applyPreset, (arg?: unknown) =>
      run(deps, "应用模板失败", () => applyPresetCommand(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.editPreset, (arg?: unknown) =>
      run(deps, "打开模板编辑器失败", async () => {
        const name = presetNameFromArg(arg) ?? (await pickPreset(deps, false, "选择要编辑的模板"));
        if (!name) {
          return;
        }
        await openPresetEditor(ctx, deps, name);
      }),
    ),
    vscode.commands.registerCommand(CMD.renamePreset, (arg?: unknown) =>
      run(deps, "重命名模板失败", () => renamePreset(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.deletePreset, (arg?: unknown) =>
      run(deps, "删除模板失败", () => deletePreset(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.exportPreset, (arg?: unknown) =>
      run(deps, "导出模板失败", () => exportPreset(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.showPresetQuickPick, () =>
      run(deps, "切换模板失败", () => applyPresetCommand(deps, undefined, true)),
    ),
    vscode.commands.registerCommand(CMD.backupNow, (arg?: unknown) =>
      run(deps, "创建备份失败", () => backupNow(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.renameBackup, (arg?: unknown) =>
      run(deps, "重命名备份失败", () => renameBackup(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.restoreBackup, (arg?: unknown) =>
      run(deps, "恢复备份失败", () => restoreBackup(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.diffBackup, (arg?: unknown) =>
      run(deps, "对比备份失败", () => diffBackup(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.deleteBackup, (arg?: unknown) =>
      run(deps, "删除备份失败", () => deleteBackup(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.exportBackup, (arg?: unknown) =>
      run(deps, "导出备份失败", () => exportBackup(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.importBackup, (arg?: unknown) =>
      run(deps, "导入备份失败", () => importBackup(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.addModel, (arg?: unknown) =>
      run(deps, "添加模型失败", () => addModel(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.deleteModel, (arg?: unknown) =>
      run(deps, "删除模型失败", () => deleteModel(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.openModelsFile, () =>
      run(deps, "打开模型清单失败", () => openModelsFile(deps)),
    ),
    vscode.commands.registerCommand(CMD.refreshTree, () => deps.refreshAll()),
  ];
  ctx.subscriptions.push(...disposables);
}

async function run(deps: ExtensionDeps, errorPrefix: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (error) {
    const message = errorMessage(error);
    deps.log(`${errorPrefix}: ${message}`);
    void vscode.window.showErrorMessage(`${errorPrefix}: ${message}`);
  }
}

function workspaceFolders(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

interface PresetPickItem extends vscode.QuickPickItem {
  presetName: string | null;
}

async function pickPreset(
  deps: ExtensionDeps,
  includeCapture: boolean,
  placeHolder: string,
): Promise<string | null | undefined> {
  const presets = deps.presetService.list();
  let current: string | null = null;
  try {
    current = deps.presetService.currentPresetName();
  } catch (error) {
    deps.log(`pickPreset: currentPresetName 失败: ${errorMessage(error)}`);
  }
  const sorted = [...presets].sort((a, b) => {
    if (a.name === current) {
      return -1;
    }
    if (b.name === current) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
  const items: PresetPickItem[] = sorted.map((preset) => ({
    label: preset.name,
    description: preset.name === current ? CURRENT_PRESET_BADGE : undefined,
    detail: preset.description,
    presetName: preset.name,
  }));
  if (includeCapture) {
    items.push({ label: "➕ 捕获新模板…", presetName: null });
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage("尚无模板，可先从当前配置捕获一个");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.presetName;
}

interface BackupPickItem extends vscode.QuickPickItem {
  entry: BackupEntry;
}

async function pickBackup(deps: ExtensionDeps, placeHolder: string): Promise<BackupEntry | undefined> {
  const entries = [...deps.backupService.list()].sort((a, b) => (a.dirName < b.dirName ? 1 : -1));
  if (entries.length === 0) {
    void vscode.window.showInformationMessage("暂无备份");
    return undefined;
  }
  const items: BackupPickItem[] = entries.map((entry) => ({
    label: entry.dirName,
    description: BACKUP_REASON_LABELS[entry.manifest.reason] ?? entry.manifest.reason,
    detail: `创建于 ${entry.manifest.createdAt}，共 ${entry.manifest.fileCount} 个文件`,
    entry,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.entry;
}

async function pickAgentTarget(deps: ExtensionDeps): Promise<AgentTarget | undefined> {
  const assignments = deps.configStore.ohMyAssignments();
  const items: (vscode.QuickPickItem & AgentTarget)[] = [];
  const push = (section: "agents" | "categories", names: readonly string[], icon: string): void => {
    for (const name of names) {
      const current = assignments[section][name];
      items.push({
        label: `${icon} ${name}`,
        description: current ? `${current.model}${current.variant ? `/${current.variant}` : ""}` : "未设置",
        section,
        name,
      });
    }
  };
  push("agents", KNOWN_AGENTS, "🤖");
  push("categories", KNOWN_CATEGORIES, "📦");
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "选择要修改的 agent / category",
    matchOnDescription: true,
  });
  return picked;
}

async function openConfigFile(deps: ExtensionDeps, arg: unknown): Promise<void> {
  // Programmatic raw-string args and node.filePath come from the command bus (tree
  // clicks pass managed paths, but any extension can executeCommand with a forged
  // arg) — both must stay inside the allowed roots (R1/P2-5).
  const openRoots = openTargetRoots(deps);
  const guardOpen = async (target: string): Promise<boolean> => {
    if (isAllowedExportTarget(target, openRoots)) {
      return true;
    }
    void vscode.window.showErrorMessage(`打开配置失败: ${OPEN_TARGET_DENIED}（${target}）`);
    return false;
  };
  if (typeof arg === "string" && arg.length > 0) {
    if (await guardOpen(arg)) {
      await openPathOrDirectory(arg);
    }
    return;
  }
  const node = toNode(arg);
  if (node) {
    if (
      node.kind === "agent" ||
      node.kind === "category" ||
      node.id?.startsWith("agent:") ||
      node.id?.startsWith("category:")
    ) {
      await vscode.commands.executeCommand(CMD.setAgentModel, arg);
      return;
    }
    if (node.kind === "guide") {
      await vscode.commands.executeCommand(CMD.createConfig);
      return;
    }
    if (node.filePath) {
      if (await guardOpen(node.filePath)) {
        await openPathOrDirectory(node.filePath);
      }
      return;
    }
  }

  // Shared discovery for both the tree-label shortcut and the interactive fallback —
  // discover() scans every managed directory, so one invocation must pay for it once.
  const discovered = deps.configStore.discover(workspaceFolders());
  if (node?.label) {
    const byLabel: Record<string, string> = {
      [path.basename(discovered.opencodeJson)]: discovered.opencodeJson,
      [path.basename(discovered.agentConfig.path)]: discovered.agentConfig.path,
    };
    const target = byLabel[node.label];
    if (target) {
      await openPathOrDirectory(target);
      return;
    }
  }
  const items: (vscode.QuickPickItem & { path: string })[] = [];
  const addFile = (label: string, filePath: string, exists: boolean): void => {
    if (exists) {
      items.push({ label, description: filePath, path: filePath });
    }
  };
  addFile(path.basename(discovered.opencodeJson), discovered.opencodeJson, fs.existsSync(discovered.opencodeJson));
  addFile(
    path.basename(discovered.agentConfig.path),
    discovered.agentConfig.path,
    fs.existsSync(discovered.agentConfig.path),
  );
  for (const agentsMd of discovered.agentsMd) {
    addFile(`AGENTS.md（${agentsMd.scope === "global" ? "全局" : "项目"}）`, agentsMd.path, agentsMd.exists);
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage("未发现任何配置，可先执行「OpenCode: 创建缺失的配置」创建");
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "打开配置" });
  if (picked) {
    await openPathOrDirectory(picked.path);
  }
}

async function openPathOrDirectory(target: string): Promise<void> {
  if (!fs.existsSync(target)) {
    void vscode.window.showErrorMessage(`文件不存在: ${target}`);
    return;
  }
  if (fs.statSync(target).isDirectory()) {
    await pickFileInDirectory(target);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target));
}

async function pickFileInDirectory(dir: string): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    defaultUri: vscode.Uri.file(dir),
    canSelectMany: false,
    openLabel: "打开",
    title: `选择 ${path.basename(dir)} 下的文件`,
  });
  if (picked && picked.length > 0) {
    await vscode.window.showTextDocument(picked[0]);
  }
}

async function createConfig(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const discovered = deps.configStore.discover(workspaceFolders());
  const agentsMdPath = path.join(discovered.configDir, "AGENTS.md");
  const agentConfigKey = discovered.agentConfig.kind === "omo" ? "omo.jsonc" : "oh-my-opencode.json";
  const allTargets: { key: keyof typeof FILE_TEMPLATES; label: string; filePath: string }[] = [
    {
      key: "opencode.json",
      label: path.basename(discovered.opencodeJson),
      filePath: discovered.opencodeJson,
    },
    {
      key: agentConfigKey,
      label: path.basename(discovered.agentConfig.path),
      filePath: discovered.agentConfig.path,
    },
    { key: "AGENTS.md", label: "AGENTS.md（全局）", filePath: agentsMdPath },
  ];
  const matchesRequest = (target: (typeof allTargets)[number], request: string): boolean =>
    target.key === request || target.label === request || path.basename(target.filePath) === request;
  const targets = allTargets.filter((target) => !fs.existsSync(target.filePath));
  if (targets.length === 0) {
    void vscode.window.showInformationMessage("所有配置均已存在");
    return;
  }
  // Programmatic form (e2e / scripts): the template key or target basename as a plain
  // string skips the QuickPick. Present-but-unknown names error out instead of falling
  // back to the picker.
  if (typeof arg === "string" && arg.trim().length > 0) {
    const request = arg.trim();
    const target = targets.find((candidate) => matchesRequest(candidate, request));
    if (!target) {
      const existing = allTargets.find((candidate) => matchesRequest(candidate, request));
      void vscode.window.showErrorMessage(
        existing ? `配置 ${existing.label} 已存在，无需创建` : `无法识别的配置文件名: ${request}`,
      );
      return;
    }
    fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
    deps.configStore.writeAtomic(target.filePath, FILE_TEMPLATES[target.key]);
    deps.refreshAll();
    void vscode.window.showInformationMessage(`已创建 ${target.label}`);
    await vscode.window.showTextDocument(vscode.Uri.file(target.filePath));
    return;
  }
  const picked = await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.label,
      description: target.filePath,
      target,
    })),
    { placeHolder: "选择要创建的配置" },
  );
  if (!picked) {
    return;
  }
  fs.mkdirSync(path.dirname(picked.target.filePath), { recursive: true });
  deps.configStore.writeAtomic(picked.target.filePath, FILE_TEMPLATES[picked.target.key]);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已创建 ${picked.target.label}`);
  await vscode.window.showTextDocument(vscode.Uri.file(picked.target.filePath));
}

async function setAgentModel(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const request = agentModelRequestFromArg(arg);
  if (request && "error" in request) {
    void vscode.window.showErrorMessage(`设置模型失败: ${request.error}`);
    return;
  }
  const target: AgentTarget | undefined = request ?? agentTargetFromArg(arg) ?? (await pickAgentTarget(deps));
  if (!target) {
    return;
  }

  let modelId: string;
  let variant: string | null;
  if (request) {
    modelId = request.model;
    variant = request.variant;
  } else {
    const assignments = deps.configStore.ohMyAssignments();
    const current = assignments[target.section][target.name];

    const models = deps.configStore.listModels();
    const modelItems: (vscode.QuickPickItem & { model: string })[] = models.map((model) => ({
      label: `${model.label} (${model.id})`,
      description: model.provider,
      model: model.id,
    }));
    modelItems.push({ label: "（手动输入…）", description: "自定义 provider/model", model: MANUAL_MODEL });
    const currentHint = current ? `（当前: ${current.model}${current.variant ? `/${current.variant}` : ""}）` : "";
    const modelPick = await vscode.window.showQuickPick(modelItems, {
      placeHolder: `选择 ${target.name} 的模型${currentHint}`,
      matchOnDescription: true,
    });
    if (!modelPick) {
      return;
    }
    modelId = modelPick.model;
    if (modelId === MANUAL_MODEL) {
      const input = await vscode.window.showInputBox({
        prompt: "输入模型 ID（provider/model）",
        placeHolder: "anthropic/claude-sonnet-4",
        validateInput: (value) =>
          MODEL_ID_PATTERN.test(value) ? undefined : "格式须为 provider/model，例如 anthropic/claude-sonnet-4",
      });
      if (!input) {
        return;
      }
      modelId = input;
    }

    const variantItems: (vscode.QuickPickItem & { variant: Variant | null })[] = [
      { label: "—", description: "不设置 variant", variant: null },
      ...VARIANTS.map((candidate) => ({ label: candidate, variant: candidate })),
    ];
    const variantPick = await vscode.window.showQuickPick(variantItems, {
      placeHolder: "选择 variant（可省略）",
    });
    if (!variantPick) {
      return;
    }
    variant = variantPick.variant;
  }

  // Core owns the write path: readTextForEdit contract, JSONC syntax abort, conflict-key
  // cleanup, mkdir, atomic write. JsoncSyntaxError / CONFIG_UNREADABLE surface as Chinese
  // via errorMessage() in run().
  deps.configStore.setAgentModel(target.section, target.name, modelId, variant);
  deps.refreshAll();
  void vscode.window.showInformationMessage(
    `已更新 ${target.name} → ${modelId}${variant ? `（variant: ${variant}）` : ""}`,
  );
}

async function capturePreset(deps: ExtensionDeps, arg: unknown): Promise<void> {
  let name: string | undefined = typeof arg === "string" && arg.length > 0 ? arg : presetNameFromArg(arg);
  if (!name) {
    const input = await vscode.window.showInputBox({
      prompt: "模板名称",
      placeHolder: "重度创作",
      validateInput: presetNameError,
    });
    name = input;
  }
  if (!name) {
    return;
  }
  const preset = deps.presetService.capture(name);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已捕获模板 ${preset.name}`);
}

async function applyPresetCommand(deps: ExtensionDeps, arg: unknown, includeCapture = false): Promise<void> {
  let name = presetNameFromArg(arg);
  if (!name) {
    const picked = await pickPreset(deps, includeCapture, "切换模板（当前项在最前）");
    if (picked === undefined) {
      return;
    }
    if (picked === null) {
      await capturePreset(deps, undefined);
      return;
    }
    name = picked;
  }
  const result = deps.presetService.apply(name);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已应用模板 ${name}（${result.changes.length} 处变更）`);
}

async function renamePreset(deps: ExtensionDeps, arg: unknown): Promise<void> {
  // Programmatic form (e2e / scripts): { from, to } — skips the picker and InputBox.
  const request = renamePresetRequestFromArg(arg);
  if (request && "error" in request) {
    void vscode.window.showErrorMessage(`重命名模板失败: ${request.error}`);
    return;
  }
  if (request) {
    deps.presetService.rename(request.from, request.to);
    deps.refreshAll();
    void vscode.window.showInformationMessage(`已重命名 ${request.from} → ${request.to}`);
    return;
  }
  const oldName = presetNameFromArg(arg) ?? (await pickPreset(deps, false, "选择要重命名的模板"));
  if (!oldName) {
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: "新的模板名称",
    value: oldName,
    validateInput: (value) => {
      const base = presetNameError(value);
      if (base) {
        return base;
      }
      if (value !== oldName && deps.presetService.exists(value)) {
        return `模板 ${value} 已存在`;
      }
      return undefined;
    },
  });
  if (!input || input === oldName) {
    return;
  }
  deps.presetService.rename(oldName, input);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已重命名 ${oldName} → ${input}`);
}

async function deletePreset(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const name = presetNameFromArg(arg) ?? (await pickPreset(deps, false, "选择要删除的模板"));
  if (!name) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `删除模板 ${name}？`,
    {
      modal: true,
      detail: "删除后无法恢复",
    },
    "删除",
  );
  if (confirm !== "删除") {
    return;
  }
  deps.presetService.remove(name);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已删除模板 ${name}`);
}

async function exportPreset(deps: ExtensionDeps, arg: unknown): Promise<void> {
  // Programmatic form (e2e / scripts): { name, target } — skips the picker and save dialog.
  const request = exportPresetRequestFromArg(arg);
  if (request && "error" in request) {
    void vscode.window.showErrorMessage(`导出模板失败: ${request.error}`);
    return;
  }
  if (request) {
    if (!isAllowedExportTarget(request.target, exportTargetRoots(deps))) {
      void vscode.window.showErrorMessage(`导出模板失败: ${EXPORT_TARGET_DENIED}（${request.target}）`);
      return;
    }
    deps.presetService.exportTo(request.name, request.target);
    deps.log(`已导出模板 ${request.name} → ${request.target}`);
    return;
  }
  const name = presetNameFromArg(arg) ?? (await pickPreset(deps, false, "选择要导出的模板"));
  if (!name) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${name}.json`),
    filters: { "JSON 文件": ["json"] },
  });
  if (!target) {
    return;
  }
  deps.presetService.exportTo(name, target.fsPath);
  void vscode.window.showInformationMessage(`已导出模板 ${name} → ${target.fsPath}`);
}

async function backupNow(deps: ExtensionDeps, arg: unknown): Promise<void> {
  // Programmatic name (e2e / command-line style invocation) bypasses the input box.
  let name: string | undefined = typeof arg === "string" && arg.trim().length > 0 ? arg.trim() : undefined;
  if (name === undefined) {
    const input = await vscode.window.showInputBox({
      title: "创建备份",
      prompt: "为这次备份起个名字，便于以后识别",
      value: "手动备份",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "名称不能为空" : undefined),
    });
    if (!input) {
      return;
    }
    name = input.trim();
  }
  deps.backupService.create("manual", { name });
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已创建备份「${name}」`);
}

async function renameBackup(deps: ExtensionDeps, arg: unknown): Promise<void> {
  // Programmatic form (e2e / scripts): { dirName, name } — skips the picker and InputBox.
  const request = renameBackupRequestFromArg(arg);
  if (request && "error" in request) {
    void vscode.window.showErrorMessage(`重命名备份失败: ${request.error}`);
    return;
  }
  if (request) {
    deps.backupService.rename(request.dirName, request.name);
    deps.refreshAll();
    void vscode.window.showInformationMessage(`备份已重命名为「${request.name}」`);
    return;
  }
  const entry = backupEntryFromArg(arg, deps.backupService.list()) ?? (await pickBackup(deps, "选择要重命名的备份"));
  if (!entry) {
    return;
  }
  const input = await vscode.window.showInputBox({
    title: "重命名备份",
    prompt: "修改备份的显示名称",
    value: entry.manifest.name ?? BACKUP_REASON_LABELS[entry.manifest.reason] ?? entry.manifest.reason,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? "名称不能为空" : undefined),
  });
  if (!input) {
    return;
  }
  const next = input.trim();
  if (next.length === 0 || next === entry.manifest.name) {
    return;
  }
  deps.backupService.rename(entry.dirName, next);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`备份已重命名为「${next}」`);
}

async function restoreBackup(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const entry = backupEntryFromArg(arg, deps.backupService.list()) ?? (await pickBackup(deps, "选择要恢复的备份"));
  if (!entry) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `恢复备份 ${entry.dirName}？当前配置将被覆盖且无法撤销`,
    { modal: true, detail: "恢复前可先「立即备份」留存当前配置" },
    "恢复",
  );
  if (confirm !== "恢复") {
    return;
  }
  deps.backupService.restore(entry.dirName);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已恢复备份 ${entry.dirName}`);
}

async function diffBackup(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const entry = backupEntryFromArg(arg, deps.backupService.list()) ?? (await pickBackup(deps, "选择要对比的备份"));
  if (!entry) {
    return;
  }
  const pairs = deps.backupService.diffPairs(entry);
  const visible = pairs.filter((pair) => fs.existsSync(pair.current));
  if (pairs.length === 0) {
    void vscode.window.showInformationMessage("备份与当前配置无差异");
    return;
  }
  if (visible.length === 0) {
    void vscode.window.showInformationMessage("备份涉及的当前文件均不存在，无法对比");
    return;
  }
  for (let i = 1; i < visible.length; i += 1) {
    deps.log(`diffBackup: 另有差异 ${visible[i].label}（${visible[i].current}），仅打开第一个`);
  }
  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(visible[0].backup),
    vscode.Uri.file(visible[0].current),
    `${visible[0].label}（备份 ↔ 当前）`,
  );
}

async function deleteBackup(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const entry = backupEntryFromArg(arg, deps.backupService.list()) ?? (await pickBackup(deps, "选择要删除的备份"));
  if (!entry) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `删除备份 ${entry.dirName}？`,
    {
      modal: true,
      detail: "删除后无法恢复",
    },
    "删除",
  );
  if (confirm !== "删除") {
    return;
  }
  deps.backupService.remove(entry.dirName);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已删除备份 ${entry.dirName}`);
}

async function exportBackup(deps: ExtensionDeps, arg: unknown): Promise<void> {
  // Programmatic form (e2e / scripts): { dirName, target } — distinct keys so a tree
  // node ({kind,id,label,filePath}) can never be mistaken for it. Either key alone
  // already marks intent (aligned with the other programmatic commands): a partial
  // shape errors out instead of silently reaching the save dialog (headless hang).
  const request = exportBackupRequestFromArg(arg);
  if (request && "error" in request) {
    void vscode.window.showErrorMessage(`导出备份失败: ${request.error}`);
    return;
  }
  if (request) {
    if (!isAllowedExportTarget(request.target, exportTargetRoots(deps))) {
      void vscode.window.showErrorMessage(`导出备份失败: ${EXPORT_TARGET_DENIED}（${request.target}）`);
      return;
    }
    await deps.backupService.exportZip(request.dirName, request.target);
    deps.log(`已导出备份 ${request.dirName} → ${request.target}`);
    return;
  }
  const entry = backupEntryFromArg(arg, deps.backupService.list()) ?? (await pickBackup(deps, "选择要导出的备份"));
  if (!entry) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${entry.dirName}.zip`),
    filters: { "Zip 压缩包": ["zip"] },
  });
  if (!target) {
    return;
  }
  await deps.backupService.exportZip(entry.dirName, target.fsPath);
  void vscode.window.showInformationMessage(`已导出备份 ${entry.dirName} → ${target.fsPath}`);
}

async function importBackup(deps: ExtensionDeps, arg: unknown): Promise<void> {
  let zipPath: string | undefined = typeof arg === "string" && arg.length > 0 ? arg : undefined;
  if (!zipPath) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "导入",
      title: "选择备份压缩包（zip）",
      filters: { "Zip 压缩包": ["zip"] },
    });
    zipPath = picked?.[0]?.fsPath;
  }
  if (!zipPath) {
    return;
  }
  const entry = await deps.backupService.importZip(zipPath);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已导入备份 ${entry.dirName}（${entry.manifest.fileCount} 个文件）`);
}

function modelIdFromArg(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.length > 0) {
    return arg;
  }
  const node = toNode(arg);
  if (node?.kind === "model" && node.id) {
    return idSuffix(node.id);
  }
  return undefined;
}

async function addModel(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const programmatic = typeof arg === "string" && arg.length > 0;
  let idInput = programmatic ? arg : undefined;
  if (!idInput) {
    idInput = await vscode.window.showInputBox({
      prompt: "模型 ID（provider/model，例如 deepseek/deepseek-v4-flash）",
      placeHolder: "provider/model",
      validateInput: (value) =>
        MODEL_ID_PATTERN.test(value) ? undefined : "格式须为 provider/model，例如 deepseek/deepseek-v4-flash",
    });
  }
  if (!idInput) {
    return;
  }
  if (!MODEL_ID_PATTERN.test(idInput)) {
    void vscode.window.showErrorMessage(`模型 ID 格式不正确: ${idInput}（须为 provider/model）`);
    return;
  }
  const label = programmatic
    ? undefined
    : await vscode.window.showInputBox({
        prompt: "显示名称（可选，留空则用模型名）",
        placeHolder: "例如 DeepSeek V4 Flash",
      });
  const [provider, model] = idInput.split("/");
  const entry = addLocalModel(deps.configStore.configDir, {
    provider,
    model,
    ...(label !== undefined && label.trim() !== "" ? { label: label.trim() } : {}),
  });
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已添加模型 ${entry.label}（${entry.id}）`);
}

async function deleteModel(deps: ExtensionDeps, arg: unknown): Promise<void> {
  const id = modelIdFromArg(arg);
  if (!id) {
    return;
  }
  const fromOpencode = deps.configStore
    .listModelEntries()
    .find((entry) => entry.option.id === id && (entry.source === "opencode" || entry.source === "both"));
  if (fromOpencode) {
    void vscode.window.showErrorMessage(`${id} 来自 opencode.json，请直接编辑该文件移除`);
    return;
  }
  const confirm = await vscode.window.showWarningMessage(`从模型清单删除 ${id}？`, { modal: true }, "删除");
  if (confirm !== "删除") {
    return;
  }
  if (!removeLocalModel(deps.configStore.configDir, id)) {
    void vscode.window.showInformationMessage(`模型清单中未找到 ${id}`);
    return;
  }
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已删除模型 ${id}`);
}

async function openModelsFile(deps: ExtensionDeps): Promise<void> {
  const filePath = path.join(deps.configStore.configDir, LOCAL_MODELS_FILE);
  if (!fs.existsSync(filePath)) {
    void vscode.window.showInformationMessage("模型清单文件尚不存在，请先「添加模型…」创建");
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(filePath));
}
