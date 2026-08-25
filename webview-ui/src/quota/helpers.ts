import type { ProviderQuota, QuotaWindow } from "@shared/protocol";
import {
  balanceColor,
  deriveRemainingPercent,
  QUOTA_WINDOW_ORDER,
  quotaCurrencySymbol,
  remainingColor,
} from "@shared/protocol";

/** Windows in the canonical display order (QUOTA_WINDOW_ORDER), regardless of API order. */
export function orderedWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  const order = new Map(QUOTA_WINDOW_ORDER.map((kind, index) => [kind, index]));
  return [...windows].sort((a, b) => (order.get(a.kind) ?? order.size) - (order.get(b.kind) ?? order.size));
}

/**
 * Bar fill percent: prefer usedPercent, else derive 100 − remainingPercent.
 * Null when both are unknown — an unknown window renders no fabricated bar.
 */
export function progressPercent(window: QuotaWindow): number | null {
  if (window.usedPercent !== null) {
    return window.usedPercent;
  }
  return window.remainingPercent !== null ? Math.round((100 - window.remainingPercent) * 10) / 10 : null;
}

function compact(value: number, divisor: number): string {
  const scaled = Math.round((value / divisor) * 10) / 10;
  return `${scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1)}`;
}

/** Chinese compact token count: 万 above 10k, 亿 above 1e9, one decimal max. */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000_000) {
    return `${compact(count, 1_000_000_000)}亿`;
  }
  if (count >= 10_000) {
    return `${compact(count, 10_000)}万`;
  }
  return String(Math.round(count));
}

/** Remaining-percent text + color band for a window row (null = no data to show). */
export function windowRemaining(window: QuotaWindow): { percent: number; colorClass: string } | null {
  const percent = deriveRemainingPercent(window);
  return percent === null ? null : { percent, colorClass: `tone-${remainingColor(percent)}` };
}

/** Balance color band for absolute amounts (pay-as-you-go rows). */
export function balanceTone(total: number): string {
  return `tone-${balanceColor(total)}`;
}

/** "¥12.35" style balance text; null without a usable total/currency pair. */
export function balanceText(balances: ProviderQuota["balances"]): string | null {
  if (balances === null || balances.total === null || balances.currency === null) {
    return null;
  }
  return `${quotaCurrencySymbol(balances.currency)}${balances.total.toFixed(2)}`;
}

/** Placeholder of the MiMo cookie field — never echoes the stored credential. */
export function cookiePlaceholder(configured: boolean): string {
  return configured ? "已配置 — 留空保持不变" : "api-platform_serviceToken=...; userId=...";
}

/** "更新于 …" header line (zh-CN locale, same shape as the status-bar tooltip). */
export function formatFetchedAt(iso: string): string {
  return `更新于 ${new Date(iso).toLocaleString("zh-CN", { hour12: false })}`;
}
