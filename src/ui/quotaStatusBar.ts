import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { formatQuotaBar, normalizeMimoCookie, type QuotaSegmentColor, type QuotaService, type QuotaSnapshot, type QuotaWindow } from "../core/quotaService";
import { applyEdits, parseSafe } from "../core/jsoncEditor";
import { CMD, CONFIG_KEY, CONFIG_SECTION } from "../constants";

export interface QuotaStatusBarDeps {
  quotaService: QuotaService;
  configDir: string;
  log(message: string): void;
}

export interface QuotaStatusBar extends vscode.Disposable {
  refresh(): Promise<void>;
}

const WINDOW_LABELS: Record<QuotaWindow["kind"], string> = {
  "5h": "5小时窗口",
  weekly: "周额度",
  monthly: "月度额度",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatReset(iso: string | null): string {
  if (!iso) {
    return "重置时间未知";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "重置时间未知" : `重置于 ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

function describeWindow(window: QuotaWindow): string {
  const remaining = window.remainingPercent ?? (window.usedPercent !== null ? Math.round((100 - window.usedPercent) * 10) / 10 : null);
  const used = window.usedPercent !== null ? `已用 ${window.usedPercent}%` : "";
  const rest = remaining !== null ? `剩余 ${remaining}%` : "额度未知";
  return [rest, used].filter(Boolean).join(" · ");
}

function snapshotToItems(snap: QuotaSnapshot): vscode.QuickPickItem[] {
  const items: vscode.QuickPickItem[] = [];
  for (const provider of snap.providers) {
    if (provider.error !== null) {
      items.push({
        label: `$(error) ${provider.label}`,
        description: provider.error,
        detail: provider.configured ? "查询失败" : "未配置凭据",
      });
      continue;
    }
    if (!provider.configured) {
      items.push({
        label: `$(circle-slash) ${provider.label}`,
        description: provider.providerId === "mimo" ? "需要配置 Dashboard Cookie" : "opencode 未登录该供应商",
      });
      continue;
    }
    for (const window of provider.windows) {
      items.push({
        label: `$(meter) ${provider.label} · ${WINDOW_LABELS[window.kind]}`,
        description: describeWindow(window),
        detail: [
          formatReset(window.resetAt),
          provider.plan ? `套餐: ${provider.plan}` : "",
          provider.balances?.total != null && provider.balances.currency
            ? `余额: ${provider.balances.total} ${provider.balances.currency}`
            : "",
        ].filter(Boolean).join(" ｜ "),
      });
    }
    if (provider.windows.length === 0 && provider.balances?.total != null && provider.balances.currency) {
      items.push({
        label: `$(credit-card) ${provider.label}`,
        description: `余额: ${provider.balances.total} ${provider.balances.currency}`,
        detail: "按量计费，无额度窗口",
      });
    }
  }
  return items;
}


function tooltipMarkdown(snap: QuotaSnapshot): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  for (const provider of snap.providers) {
    if (provider.error !== null) {
      md.appendMarkdown(`- **${provider.label}**：${provider.error}\n`);
      continue;
    }
    const windows = provider.windows.map((w) => `${WINDOW_LABELS[w.kind]} ${describeWindow(w)}`).join("；");
    const balance = provider.balances?.total != null && provider.balances.currency ? `余额 ${provider.balances.total} ${provider.balances.currency}` : null;
    const meta = [provider.plan, balance].filter(Boolean).join(" · ");
    const body = windows || (balance ? "按量计费" : "暂无额度数据");
    md.appendMarkdown(`- **${provider.label}**${meta ? `（${meta}）` : ""}：${body}\n`);
  }
  md.appendMarkdown(`\n更新于 ${new Date(snap.fetchedAt).toLocaleString("zh-CN", { hour12: false })} · 点击查看详情`);
  return md;
}

// opencode TUI default-theme palettes extracted from the running binary. The user's status bar
// is light-themed, so segments must use the theme's LIGHT variants; dark variants apply when
// VSCode itself switches to a dark theme. Both sets match what the opencode terminal shows.
const DARK_SEGMENT_COLORS: Record<QuotaSegmentColor, string | undefined> = {
  green: "#7FD88F",
  yellow: "#F5A742",
  red: "#E06C75",
  neutral: undefined,
};

const LIGHT_SEGMENT_COLORS: Record<QuotaSegmentColor, string | undefined> = {
  green: "#3D9A57",
  yellow: "#D68C27",
  red: "#D1383D",
  neutral: undefined,
};

function segmentColors(): Record<QuotaSegmentColor, string | undefined> {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? LIGHT_SEGMENT_COLORS
    : DARK_SEGMENT_COLORS;
}

export function createQuotaStatusBar(deps: QuotaStatusBarDeps): QuotaStatusBar {
  let items: vscode.StatusBarItem[] = [];
  let snapshot: QuotaSnapshot | null = null;
  let refreshing = false;

  // One status-bar item per (provider, window) segment — VSCode items are single-colored, so
  // per-window colors require separate items. Higher priority sits further left (right-aligned).
  // Item pool: when the segment count is unchanged, existing StatusBarItems are updated in
  // place (text/color/tooltip only); a full rebuild happens solely when the count changes.
  // Recreating every item on each 30s refresh caused constant create/dispose RPC + status-bar
  // relayout churn in the renderer.
  const render = (): void => {
    const segments = snapshot ? formatQuotaBar(snapshot).segments : [];
    const palette = segmentColors();
    const rows =
      segments.length > 0 ? segments : [{ text: "Coding Plan", color: "neutral" as const }];
    const tooltip =
      segments.length === 0 && !snapshot
        ? "点击查询 Coding Plan 剩余额度"
        : snapshot
          ? tooltipMarkdown(snapshot)
          : undefined;
    const base = 90 + rows.length;
    if (items.length !== rows.length) {
      for (const existing of items) {
        existing.dispose();
      }
      items = rows.map((_, index) => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, base - index);
        item.name = "Coding Plan 额度";
        item.command = CMD.quotaRefresh;
        return item;
      });
    }
    rows.forEach((row, index) => {
      const item = items[index];
      item.text = index === 0 ? `$(bolt) ${row.text}` : row.text;
      item.color = palette[row.color];
      item.tooltip = tooltip;
      item.show();
    });
  };

  const refresh = async (): Promise<void> => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    try {
      snapshot = await deps.quotaService.fetchAll();
      render();
    } catch (error) {
      deps.log(`quota: 刷新失败: ${errorMessage(error)}`);
      render();
      if (items[0]) {
        items[0].text = "$(bolt) 额度 ?";
        items[0].tooltip = `查询失败: ${errorMessage(error)}`;
      }
    } finally {
      refreshing = false;
    }
  };

  const refreshSeconds = (): number => {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(CONFIG_KEY.quotaRefreshSeconds.replace(`${CONFIG_SECTION}.`, ""));
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 30;
  };

  let timer: NodeJS.Timeout | undefined;
  const armTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const seconds = refreshSeconds();
    if (seconds > 0) {
      timer = setInterval(() => void refresh(), seconds * 1_000);
    }
  };

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_KEY.quotaRefreshSeconds)) {
      armTimer();
      void refresh();
    }
  });

  const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
    render();
  });

  async function showQuotaDetail(): Promise<void> {
    if (!snapshot) {
      await refresh();
    }
    const snap = snapshot;
    if (!snap) {
      void vscode.window.showErrorMessage("额度查询失败，稍后重试");
      return;
    }
    const refreshAction: vscode.QuickPickItem = {
      label: "刷新",
      description: "立即重新查询",
      iconPath: new vscode.ThemeIcon("refresh"),
    };
    const mimoAction: vscode.QuickPickItem = {
      label: "配置 MiMo Cookie…",
      description: "MiMo 额度需要 platform.xiaomimimo.com 的浏览器 Cookie",
      iconPath: new vscode.ThemeIcon("key"),
    };
    const picked = await vscode.window.showQuickPick(
      [...snapshotToItems(snap), { label: "", kind: vscode.QuickPickItemKind.Separator }, refreshAction, mimoAction],
      { placeHolder: "Coding Plan 剩余额度（点击刷新或配置 MiMo）" },
    );
    if (picked === refreshAction) {
      await refresh();
      await showQuotaDetail();
      return;
    }
    if (picked === mimoAction) {
      await vscode.commands.executeCommand(CMD.quotaConfigureMimo);
    }
  }

  const commandDisposables = [
    vscode.commands.registerCommand(CMD.quotaRefresh, () => void showQuotaDetail()),
    vscode.commands.registerCommand(CMD.quotaConfigureMimo, async () => {
      const saved = await configureMimoCookie({ configDir: deps.configDir, log: deps.log });
      if (saved) {
        void refresh();
      }
    }),
  ];

  armTimer();
  render();
  void refresh();

  return {
    refresh,
    dispose(): void {
      if (timer !== undefined) {
        clearInterval(timer);
      }
      configListener.dispose();
      themeListener.dispose();
      for (const disposable of commandDisposables) {
        disposable.dispose();
      }
      for (const item of items) {
        item.dispose();
      }
    },
  };
}

export async function configureMimoCookie(deps: { configDir: string; log(message: string): void }): Promise<boolean> {
  const input = await vscode.window.showInputBox({
    title: "配置 MiMo Dashboard Cookie",
    prompt: "登录 platform.xiaomimimo.com → F12 → Network → 任选 /api/v1/balance 请求 → 复制请求头里的 Cookie 值",
    placeHolder: "api-platform_serviceToken=...; userId=...",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (normalizeMimoCookie(value) === null ? "必须同时包含 api-platform_serviceToken 与 userId" : undefined),
  });
  if (!input) {
    return false;
  }
  const cookie = normalizeMimoCookie(input);
  if (cookie === null) {
    return false;
  }
  const file = path.join(deps.configDir, "quota.json");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = parseSafe<Record<string, unknown>>(current);
  const next = applyEdits(current.length > 0 && parsed.errors.length === 0 ? current : "{}", [
    { path: ["mimo", "cookie"], value: cookie, op: "set" },
  ]);
  fs.mkdirSync(deps.configDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(tmp, next, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  deps.log("quota: 已写入 MiMo Cookie（quota.json）");
  void vscode.window.showInformationMessage("MiMo Cookie 已保存，正在刷新额度");
  return true;
}
