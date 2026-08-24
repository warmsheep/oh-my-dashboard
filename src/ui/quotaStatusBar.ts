import * as vscode from "vscode";

import { CMD, CONFIG_KEY, CONFIG_LEAF, CONFIG_SECTION } from "../constants";
import { errorMessage } from "../core/errors";
import {
  deriveRemainingPercent,
  formatQuotaBar,
  normalizeMimoCookie,
  quotaCycleFailed,
  quotaRetryDelayMs,
} from "../core/quotaService";
import type { QuotaSegmentColor, QuotaService, QuotaSnapshot, QuotaWindow } from "../core/quotaService";

export interface QuotaStatusBarDeps {
  quotaService: QuotaService;
  log(message: string): void;
}

export interface QuotaStatusBar extends vscode.Disposable {
  refresh(): Promise<void>;
}

const WINDOW_LABELS: Record<QuotaWindow["kind"], string> = {
  "5h": "5小时额度",
  weekly: "周额度",
  monthly: "月额度",
};

function formatReset(iso: string | null): string {
  if (!iso) {
    return "重置时间未知";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "重置时间未知" : `重置于 ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

function describeWindow(window: QuotaWindow): string {
  const remaining = deriveRemainingPercent(window);
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
        ]
          .filter(Boolean)
          .join(" ｜ "),
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
      // Error text is remote-controlled (API messages) — appendText escapes markdown so
      // links/images can never be injected into the hover.
      md.appendMarkdown(`- **${provider.label}**：`);
      md.appendText(provider.error);
      md.appendMarkdown(`\n`);
      continue;
    }
    const windows = provider.windows.map((w) => `${WINDOW_LABELS[w.kind]} ${describeWindow(w)}`).join("；");
    const balance =
      provider.balances?.total != null && provider.balances.currency
        ? `余额 ${provider.balances.total} ${provider.balances.currency}`
        : null;
    const body = windows || (balance ? "按量计费" : "暂无额度数据");
    md.appendMarkdown(`- **${provider.label}**`);
    if (provider.plan !== null || balance !== null) {
      md.appendMarkdown(`（`);
      // The plan name is remote-controlled (Kimi/GLM/MiMo subscription levels) —
      // appendText escapes markdown, same defense as the error line above.
      if (provider.plan !== null) {
        md.appendText(provider.plan);
      }
      if (provider.plan !== null && balance !== null) {
        md.appendMarkdown(` · `);
      }
      if (balance !== null) {
        md.appendMarkdown(balance);
      }
      md.appendMarkdown(`）`);
    }
    md.appendMarkdown(`：${body}\n`);
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

/** Create the Coding-Plan quota status-bar segments + self-scheduling refresh timer (backoff on network failures); registers its own commands and listeners, all disposed together. */
export function createQuotaStatusBar(deps: QuotaStatusBarDeps): QuotaStatusBar {
  let items: vscode.StatusBarItem[] = [];
  let snapshot: QuotaSnapshot | null = null;
  let refreshPromise: Promise<void> | null = null;
  let failureStreak = 0;
  let disposed = false;

  // One status-bar item per (provider, window) segment — VSCode items are single-colored, so
  // per-window colors require separate items. Higher priority sits further left (right-aligned).
  // Item pool: when the segment count is unchanged, existing StatusBarItems are updated in
  // place (text/color/tooltip only); a full rebuild happens solely when the count changes.
  // Recreating every item on each 30s refresh caused constant create/dispose RPC + status-bar
  // relayout churn in the renderer.
  const render = (): void => {
    if (disposed) {
      return;
    }
    const segments = snapshot ? formatQuotaBar(snapshot).segments : [];
    const palette = segmentColors();
    const rows = segments.length > 0 ? segments : [{ text: "Coding Plan", color: "neutral" as const }];
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

  // Single-flight via a shared promise: concurrent triggers (timer tick, status-bar click,
  // QuickPick refresh) all await the SAME in-flight cycle instead of silently returning early.
  const refresh = (): Promise<void> => {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          snapshot = await deps.quotaService.fetchAll();
          failureStreak = quotaCycleFailed(snapshot) ? failureStreak + 1 : 0;
          render();
        } catch (error) {
          failureStreak += 1;
          deps.log(`quota: 刷新失败: ${errorMessage(error)}`);
        } finally {
          refreshPromise = null;
          scheduleNext();
        }
      })();
    }
    return refreshPromise;
  };

  const refreshSeconds = (): number => {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(CONFIG_LEAF.quotaRefreshSeconds);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 30;
  };

  // Self-scheduling setTimeout chain (NOT setInterval): each next tick is armed only after the
  // current cycle settles, with exponential backoff on network failures. Offline, undici's DNS
  // lookups keep occupying libuv threadpool threads even after AbortSignal fires; retrying every
  // 30s starves the shared pool and freezes async fs for every other extension in the host.
  let timer: NodeJS.Timeout | undefined;
  const scheduleNext = (): void => {
    if (disposed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const delayMs = quotaRetryDelayMs(refreshSeconds(), failureStreak);
    if (delayMs > 0) {
      timer = setTimeout(() => void refresh(), delayMs);
    }
  };

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_KEY.quotaRefreshSeconds)) {
      failureStreak = 0;
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
      try {
        const saved = await configureMimoCookie({ quotaService: deps.quotaService, log: deps.log });
        if (saved) {
          void refresh();
        }
      } catch (error) {
        deps.log(`quota: 配置 MiMo Cookie 失败: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`配置 MiMo Cookie 失败: ${errorMessage(error)}`);
      }
    }),
  ];

  render();
  void refresh();

  return {
    refresh,
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const item of items.splice(0)) {
        item.dispose();
      }
      configListener.dispose();
      themeListener.dispose();
      for (const disposable of commandDisposables) {
        disposable.dispose();
      }
    },
  };
}

/** Prompt for a MiMo dashboard cookie and persist it via quotaService.saveMimoCookie (quota.json); returns false when the input box is cancelled. */
export async function configureMimoCookie(deps: {
  quotaService: QuotaService;
  log(message: string): void;
}): Promise<boolean> {
  const input = await vscode.window.showInputBox({
    title: "配置 MiMo Dashboard Cookie",
    prompt: "登录 platform.xiaomimimo.com → F12 → Network → 任选 /api/v1/balance 请求 → 复制请求头里的 Cookie 值",
    placeHolder: "api-platform_serviceToken=...; userId=...",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      normalizeMimoCookie(value) === null ? "必须同时包含 api-platform_serviceToken 与 userId" : undefined,
  });
  if (!input) {
    return false;
  }
  // Core owns persistence: merge into quota.json (heal-on-corrupt), mkdir, atomic write and
  // chmod 0600. Invalid cookies raise MIMO_COOKIE_INVALID, unreadable quota.json raises
  // CONFIG_UNREADABLE — both mapped to Chinese by errorMessage() at the caller.
  deps.quotaService.saveMimoCookie(input);
  deps.log("quota: 已写入 MiMo Cookie（quota.json）");
  void vscode.window.showInformationMessage("MiMo Cookie 已保存，正在刷新额度");
  return true;
}
