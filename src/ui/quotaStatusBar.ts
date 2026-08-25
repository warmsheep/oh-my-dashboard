import * as vscode from "vscode";

import { CMD, CONFIG_KEY, CONFIG_LEAF, CONFIG_SECTION } from "../constants";
import { errorMessage } from "../core/errors";
import {
  formatQuotaBar,
  mergeProviderSnapshot,
  quotaCycleFailed,
  quotaRetryDelayMs,
  quotaShouldPauseAutoRefresh,
} from "../core/quotaService";
import type { QuotaSegmentColor, QuotaService, QuotaSnapshot, QuotaWindow } from "../core/quotaService";
import {
  deriveRemainingPercent,
  QUOTA_REFRESH_DEFAULT_SECONDS,
  QUOTA_REFRESH_MAX_SECONDS,
  QUOTA_REFRESH_MIN_SECONDS,
  quotaWindowLabel,
} from "../shared/protocol";
import type { QuotaProviderId } from "../shared/protocol";

export interface QuotaStatusBarDeps {
  quotaService: QuotaService;
  log(message: string): void;
}

/**
 * Status-bar surface consumed by the quota panel host: cached snapshot access,
 * single-flight refresh cycles, per-provider refresh with merge-back, and a
 * snapshot event the panel subscribes to while visible.
 */
export interface QuotaStatusBar extends vscode.Disposable {
  refresh(): Promise<void>;
  getSnapshot(): QuotaSnapshot | null;
  refreshProvider(providerId: QuotaProviderId): Promise<QuotaSnapshot | null>;
  onSnapshot: vscode.Event<QuotaSnapshot>;
}

function describeWindow(window: QuotaWindow): string {
  const remaining = deriveRemainingPercent(window);
  const used = window.usedPercent !== null ? `已用 ${window.usedPercent}%` : "";
  const rest = remaining !== null ? `剩余 ${remaining}%` : "额度未知";
  return [rest, used].filter(Boolean).join(" · ");
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
    const windows = provider.windows.map((w) => `${quotaWindowLabel(w.kind)} ${describeWindow(w)}`).join("；");
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

  // Single-flight via a shared promise: concurrent triggers (timer tick, panel refresh-all,
  // config change) all await the SAME in-flight cycle instead of silently returning early.
  const refresh = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          snapshot = await deps.quotaService.fetchAll();
          const failed = quotaCycleFailed(snapshot);
          failureStreak = failed ? failureStreak + 1 : 0;
          if (!failed) {
            pausedLogged = false;
          }
          render();
          if (!disposed) {
            snapshotEmitter.fire(snapshot);
          }
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
    // Shared bounds keep the status bar in lockstep with the settings page's
    // normalized view — a hand-edited out-of-range value must not make the two
    // disagree about the effective interval (or whether 0 = off).
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return QUOTA_REFRESH_DEFAULT_SECONDS;
    }
    return Math.min(QUOTA_REFRESH_MAX_SECONDS, Math.max(QUOTA_REFRESH_MIN_SECONDS, value));
  };

  // Self-scheduling setTimeout chain (NOT setInterval): each next tick is armed only after the
  // current cycle settles, with exponential backoff on network failures, then a full circuit
  // breaker — undici's DNS lookups park libuv threadpool threads even after AbortSignal fires
  // (the pool is shared by EVERY extension's async fs), so persistent transport failures must
  // stop the cycle entirely instead of poking the pool forever.
  let pausedLogged = false;
  let timer: NodeJS.Timeout | undefined;
  const scheduleNext = (): void => {
    if (disposed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (quotaShouldPauseAutoRefresh(failureStreak)) {
      if (!pausedLogged) {
        pausedLogged = true;
        deps.log("quota: 连续网络失败已达上限，自动刷新已暂停（手动刷新成功或修改设置后恢复）");
      }
      return;
    }
    const delayMs = quotaRetryDelayMs(refreshSeconds(), failureStreak);
    if (delayMs > 0) {
      timer = setTimeout(() => void refresh(), delayMs);
    }
  };

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_KEY.quotaRefreshSeconds)) {
      failureStreak = 0;
      pausedLogged = false;
      scheduleNext();
      void refresh();
    }
  });

  const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
    render();
  });

  const snapshotEmitter = new vscode.EventEmitter<QuotaSnapshot>();

  /**
   * Refresh one provider and merge it into the cached snapshot (panel per-group refresh).
   * With no cached snapshot yet, falls back to a full cycle so every group fills at once.
   * A successful solo refresh also re-arms the auto-refresh cycle (the network is back —
   * the breaker may have paused it) and always fires onSnapshot when a snapshot exists —
   * the panel relies on that single channel to settle its pending markers.
   */
  const refreshProvider = async (providerId: QuotaProviderId): Promise<QuotaSnapshot | null> => {
    if (disposed) {
      return snapshot;
    }
    if (!snapshot) {
      await refresh();
      return snapshot;
    }
    try {
      const provider = await deps.quotaService.fetchProvider(providerId);
      snapshot = mergeProviderSnapshot(snapshot, provider, new Date().toISOString());
      failureStreak = 0;
      pausedLogged = false;
      scheduleNext();
      render();
    } catch (error) {
      deps.log(`quota: 刷新 ${providerId} 失败: ${errorMessage(error)}`);
    }
    if (!disposed) {
      snapshotEmitter.fire(snapshot);
    }
    return snapshot;
  };

  render();
  // Delayed first cycle: activation overlaps other extensions' startup IO (language
  // servers, git) — the gate already bounds concurrency, and a few seconds' delay
  // keeps this extension out of that contention window entirely.
  timer = setTimeout(() => void refresh(), 5_000);

  return {
    refresh,
    getSnapshot: () => snapshot,
    refreshProvider,
    onSnapshot: snapshotEmitter.event,
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
      snapshotEmitter.dispose();
    },
  };
}
