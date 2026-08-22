import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { addLocalModel, removeLocalModel, LOCAL_MODELS_FILE } from "../core/builtinModels";
import { applyEdits, validate } from "../core/jsoncEditor";
import type { JsoncEdit } from "../core/jsoncEditor";
import type { BackupEntry, Variant } from "../core/types";
import { KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANTS } from "../core/types";
import type { BackupService } from "../core/backupService";
import type { ConfigStore } from "../core/configStore";
import type { PresetService } from "../core/presetService";
import { CMD, FILE_TEMPLATES, MODEL_ID_PATTERN, PRESET_NAME_PATTERN } from "../constants";
import { openPresetEditor } from "../webview/presetEditorHost";

export interface ExtensionDeps {
  configStore: ConfigStore;
  backupService: BackupService;
  presetService: PresetService;
  refreshAll(): void;
  log(message: string): void;
}

interface NodeLike {
  kind?: string;
  id?: string;
  label?: string;
  description?: string;
  filePath?: string;
}

interface AgentTarget {
  section: "agents" | "categories";
  name: string;
}

const MANUAL_MODEL = "__manual__";

const BACKUP_REASON_LABELS: Record<string, string> = {
  manual: "手动",
  "pre-apply": "应用前",
  "pre-save": "保存前",
  "pre-restore": "恢复前",
};

export function registerCommands(ctx: vscode.ExtensionContext, deps: ExtensionDeps): void {
  const disposables = [
    vscode.commands.registerCommand(CMD.openConfigFile, (arg?: unknown) =>
      run(deps, "打开配置失败", () => openConfigFile(deps, arg)),
    ),
    vscode.commands.registerCommand(CMD.createConfig, () =>
      run(deps, "创建配置失败", () => createConfig(deps)),
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

async function run(
  deps: ExtensionDeps,
  errorPrefix: string,
  body: () => Promise<void> | void,
): Promise<void> {
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

function toNode(arg: unknown): NodeLike | undefined {
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    return undefined;
  }
  const n = arg as Record<string, unknown>;
  return {
    kind: typeof n.kind === "string" ? n.kind : undefined,
    id: typeof n.id === "string" ? n.id : undefined,
    label: typeof n.label === "string" ? n.label : undefined,
    description: typeof n.description === "string" ? n.description : undefined,
    filePath: typeof n.filePath === "string" ? n.filePath : undefined,
  };
}

function idSuffix(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  const idx = id.indexOf(":");
  return idx >= 0 ? id.slice(idx + 1) : undefined;
}

function presetNameFromArg(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.length > 0) {
    return arg;
  }
  const node = toNode(arg);
  if (!node || (node.kind !== undefined && node.kind !== "preset")) {
    return undefined;
  }
  return node.label ?? idSuffix(node.id);
}

function agentTargetFromArg(arg: unknown): AgentTarget | undefined {
  const node = toNode(arg);
  if (!node) {
    return undefined;
  }
  const isAgent = node.kind === "agent" || node.id?.startsWith("agent:");
  const isCategory = node.kind === "category" || node.id?.startsWith("category:");
  if (!isAgent && !isCategory) {
    return undefined;
  }
  const name = idSuffix(node.id) ?? node.label;
  if (!name) {
    return undefined;
  }
  return { section: isAgent ? "agents" : "categories", name };
}

function backupFromArg(deps: ExtensionDeps, arg: unknown): BackupEntry | undefined {
  const entries = deps.backupService.list();
  if (typeof arg === "string" && arg.length > 0) {
    return entries.find((entry) => entry.dirName === arg);
  }
  const node = toNode(arg);
  if (!node) {
    return undefined;
  }
  const candidate = idSuffix(node.id);
  if (candidate) {
    const hit = entries.find((entry) => entry.dirName === candidate);
    if (hit) {
      return hit;
    }
  }
  if (node.filePath) {
    const hit = entries.find(
      (entry) => entry.dir === node.filePath || entry.dirName === path.basename(node.filePath ?? ""),
    );
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function validatePresetName(value: string): string | undefined {
  return PRESET_NAME_PATTERN.test(value) ? undefined : "名称须为 1-64 个字符，且不含 / 或 \\";
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
    description: preset.name === current ? "（当前）" : undefined,
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
  if (typeof arg === "string" && arg.length > 0) {
    await openPathOrDirectory(arg);
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
      await openPathOrDirectory(node.filePath);
      return;
    }
    if (node.kind === "dirSummary") {
      const discovered = deps.configStore.discover(workspaceFolders());
      const dir = node.label?.includes("command")
        ? discovered.commandDir
        : node.label?.toLowerCase().includes("skill")
          ? discovered.skillsDir
          : undefined;
      if (dir) {
        await pickFileInDirectory(dir);
        return;
      }
    }
    if (node.label) {
      const discovered = deps.configStore.discover(workspaceFolders());
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
  }

  const discovered = deps.configStore.discover(workspaceFolders());
  const items: (vscode.QuickPickItem & { path: string })[] = [];
  const addFile = (label: string, filePath: string, exists: boolean): void => {
    if (exists) {
      items.push({ label, description: filePath, path: filePath });
    }
  };
  addFile(
    path.basename(discovered.opencodeJson),
    discovered.opencodeJson,
    fs.existsSync(discovered.opencodeJson),
  );
  addFile(
    path.basename(discovered.agentConfig.path),
    discovered.agentConfig.path,
    fs.existsSync(discovered.agentConfig.path),
  );
  for (const agentsMd of discovered.agentsMd) {
    addFile(
      `AGENTS.md（${agentsMd.scope === "global" ? "全局" : "项目"}）`,
      agentsMd.path,
      agentsMd.exists,
    );
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "未发现任何配置，可先执行「OpenCode: 创建缺失的配置」创建",
    );
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

async function createConfig(deps: ExtensionDeps): Promise<void> {
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
  const targets = allTargets.filter((target) => !fs.existsSync(target.filePath));
  if (targets.length === 0) {
    void vscode.window.showInformationMessage("所有配置均已存在");
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
  const target = agentTargetFromArg(arg) ?? (await pickAgentTarget(deps));
  if (!target) {
    return;
  }
  const assignments = deps.configStore.ohMyAssignments();
  const current = assignments[target.section][target.name];

  const models = deps.configStore.listModels();
  const modelItems: (vscode.QuickPickItem & { model: string })[] = models.map((model) => ({
    label: `${model.label} (${model.id})`,
    description: model.provider,
    model: model.id,
  }));
  modelItems.push({ label: "（手动输入…）", description: "自定义 provider/model", model: MANUAL_MODEL });
  const currentHint = current
    ? `（当前: ${current.model}${current.variant ? `/${current.variant}` : ""}）`
    : "";
  const modelPick = await vscode.window.showQuickPick(modelItems, {
    placeHolder: `选择 ${target.name} 的模型${currentHint}`,
    matchOnDescription: true,
  });
  if (!modelPick) {
    return;
  }
  let modelId = modelPick.model;
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
    ...VARIANTS.map((variant) => ({ label: variant, variant })),
  ];
  const variantPick = await vscode.window.showQuickPick(variantItems, {
    placeHolder: "选择 variant（可省略）",
  });
  if (!variantPick) {
    return;
  }

  const discovered = deps.configStore.discover(workspaceFolders());
  const agentConfig = discovered.agentConfig;
  const agentFileName = path.basename(agentConfig.path);
  const raw = deps.configStore.readTextOrEmpty(agentConfig.path);
  if (raw.length > 0) {
    const errors = validate(raw);
    if (errors.length > 0) {
      void vscode.window.showErrorMessage(
        `${agentFileName} 存在 JSONC 语法错误，已取消修改，请先修复后再试`,
      );
      return;
    }
  }
  const base = [...agentConfig.sectionPath, target.section, target.name];
  const otherReasoningKey = agentConfig.reasoningKey === "reasoning" ? "variant" : "reasoning";
  const edits: JsoncEdit[] = [
    { path: [...base, "model"], value: modelId },
    variantPick.variant === null
      ? { path: [...base, agentConfig.reasoningKey], value: undefined, op: "remove" }
      : { path: [...base, agentConfig.reasoningKey], value: variantPick.variant },
    { path: [...base, otherReasoningKey], value: undefined, op: "remove" },
    { path: [...base, "models"], value: undefined, op: "remove" },
  ];
  const next = applyEdits(raw.length > 0 ? raw : "{}", edits);
  fs.mkdirSync(path.dirname(agentConfig.path), { recursive: true });
  deps.configStore.writeAtomic(agentConfig.path, next);
  deps.refreshAll();
  void vscode.window.showInformationMessage(
    `已更新 ${target.name} → ${modelId}${variantPick.variant ? `（variant: ${variantPick.variant}）` : ""}`,
  );
}

async function capturePreset(deps: ExtensionDeps, arg: unknown): Promise<void> {
  let name: string | undefined =
    typeof arg === "string" && arg.length > 0 ? arg : presetNameFromArg(arg);
  if (!name) {
    const input = await vscode.window.showInputBox({
      prompt: "模板名称",
      placeHolder: "重度创作",
      validateInput: validatePresetName,
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

async function applyPresetCommand(
  deps: ExtensionDeps,
  arg: unknown,
  includeCapture = false,
): Promise<void> {
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
  const oldName = presetNameFromArg(arg) ?? (await pickPreset(deps, false, "选择要重命名的模板"));
  if (!oldName) {
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: "新的模板名称",
    value: oldName,
    validateInput: (value) => {
      const base = validatePresetName(value);
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
  const confirm = await vscode.window.showWarningMessage(`删除模板 ${name}？`, {
    modal: true,
    detail: "删除后无法恢复",
  }, "删除");
  if (confirm !== "删除") {
    return;
  }
  deps.presetService.remove(name);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已删除模板 ${name}`);
}

async function exportPreset(deps: ExtensionDeps, arg: unknown): Promise<void> {
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
  const entry = backupFromArg(deps, arg) ?? (await pickBackup(deps, "选择要重命名的备份"));
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
  const entry = backupFromArg(deps, arg) ?? (await pickBackup(deps, "选择要恢复的备份"));
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
  const entry = backupFromArg(deps, arg) ?? (await pickBackup(deps, "选择要对比的备份"));
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
  const entry = backupFromArg(deps, arg) ?? (await pickBackup(deps, "选择要删除的备份"));
  if (!entry) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(`删除备份 ${entry.dirName}？`, {
    modal: true,
    detail: "删除后无法恢复",
  }, "删除");
  if (confirm !== "删除") {
    return;
  }
  deps.backupService.remove(entry.dirName);
  deps.refreshAll();
  void vscode.window.showInformationMessage(`已删除备份 ${entry.dirName}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const confirm = await vscode.window.showWarningMessage(
    `从模型清单删除 ${id}？`,
    { modal: true },
    "删除",
  );
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
