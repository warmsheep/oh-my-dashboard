/**
 * Frozen contract shared by the extension host and the webview UI. This module is
 * bundled on BOTH sides (webview via the @shared alias) and must stay dependency-free:
 * no runtime imports, no imports outside this directory, and never vscode or core here.
 */

export type Variant = "low" | "medium" | "high" | "xhigh" | "max";

/** The classic five reasoning levels; omo also accepts harness-native tokens beyond these. */
export const VARIANTS: readonly Variant[] = ["low", "medium", "high", "xhigh", "max"];

/** Canonical display order of the reasoning variants (webview dropdowns, tree rows). */
export const VARIANT_ORDER: readonly Variant[] = VARIANTS;

/** One selectable model in the merged catalog (opencode.json providers + local models.json). */
export interface ModelOption {
  id: string;
  provider: string;
  model: string;
  label: string;
}

/**
 * Canonical oh-my-openagent agent names, in display order. Single source of truth —
 * core/types.ts re-exports this for the extension side; the webview imports it via
 * the @shared alias (no third copy).
 */
export const KNOWN_AGENTS: readonly string[] = [
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus",
  "sisyphus-junior",
];

/** Canonical oh-my-openagent category names, in display order (see KNOWN_AGENTS). */
export const KNOWN_CATEGORIES: readonly string[] = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
  "architect",
  "backend",
  "frontend",
  "qa",
  "product",
];

export interface PresetRow {
  section: "agents" | "categories";
  name: string;
  model: string | null;
  /** Reasoning level; wider than the classic five variants (omo accepts "off"/"minimal"/...). */
  variant: string | null;
}

export interface WebviewInitPayload {
  preset: { name: string; description?: string; rows: PresetRow[] };
  models: ModelOption[];
}

export type ExtToWebview =
  | { type: "init"; payload: WebviewInitPayload }
  /** Sent when building/sending the init payload failed (e.g. listModels threw): replaces the boot screen with the error. */
  | { type: "initFailed"; payload: { error: string } }
  | { type: "modelsUpdated"; payload: { models: ModelOption[] } }
  | { type: "result"; payload: { action: "save" | "apply"; ok: boolean; error?: string } }
  /** Quota view boot payload: cached snapshot (null before the first refresh cycle), per-provider
   *  status-bar visibility, and an optional focus target. */
  | { type: "quotaInit"; payload: QuotaInitPayload }
  /** Fresh quota data — manual refresh results and auto-refresh cycle pushes share this channel. */
  | { type: "quotaSnapshot"; payload: { snapshot: QuotaSnapshot } }
  /** Reply to quotaSaveMimoCookie: ok carries no error, !ok carries the friendly Chinese message. */
  | { type: "quotaConfigSaved"; payload: { ok: boolean; error?: string } }
  /** Reply to quotaSetStatusBar: ok echoes the persisted full visibility record; !ok carries the error. */
  | { type: "quotaStatusBarSaved"; payload: { ok: boolean; visibility?: QuotaVisibility; error?: string } }
  /** Liveness probe for the open manager panel: a booted-once page must answer with `pong`. */
  | { type: "quotaPing" }
  /** Switch the manager page to a tab (command entry points land on their target tab). */
  | { type: "managerNavigate"; payload: ManagerNavigatePayload }
  /** Settings view boot payload AND external-change push (Settings-UI edits re-sync the open page). */
  | { type: "settingsInit"; payload: SettingsInitPayload }
  /** Reply to settingsSave: ok carries no error, !ok carries the friendly Chinese message. */
  | { type: "settingsSaved"; payload: { ok: boolean; error?: string } };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "dirty"; payload: boolean }
  | { type: "cancel" }
  | { type: "save"; payload: { name: string; description?: string; rows: PresetRow[]; apply: boolean } }
  /** Manual refresh from the quota view; providerId omitted (or undefined) means refresh all providers. */
  | { type: "quotaRefresh"; payload?: { providerId?: QuotaProviderId } }
  | { type: "quotaSaveMimoCookie"; payload: { cookie: string } }
  /** Toggle one provider's status-bar visibility (persisted into quota.json by the host). */
  | { type: "quotaSetStatusBar"; payload: { providerId: QuotaProviderId; visible: boolean } }
  /** Answer to quotaPing — proves the webview's JS context is still alive. */
  | { type: "pong" }
  /** Persist the whole settings form (idempotent full-object save; values re-normalized host-side). */
  | { type: "settingsSave"; payload: { settings: AutoRefreshSettings } };

// ---------------------------------------------------------------------------
// Quota view contract — data shapes consumed by BOTH the extension host
// (quotaService) and the manager webview bundle (manager.html, 额度 tab), so
// they live here instead of core (which the webview must not pull in:
// node:fs dependencies).
// ---------------------------------------------------------------------------

export type QuotaProviderId = "kimi" | "glm" | "mimo" | "deepseek";
export type QuotaWindowKind = "5h" | "weekly" | "monthly";

export interface QuotaWindow {
  kind: QuotaWindowKind;
  usedPercent: number | null;
  remainingPercent: number | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface ProviderQuota {
  providerId: QuotaProviderId;
  label: string;
  plan: string | null;
  windows: QuotaWindow[];
  balances: { total: number | null; currency: string | null } | null;
  configured: boolean;
  error: string | null;
  /**
   * ISO time of the last successful fetch, present only when windows/balances are
   * stale data kept for display while `error` carries the latest failure reason.
   */
  staleFetchedAt?: string;
}

export interface QuotaSnapshot {
  providers: ProviderQuota[];
  fetchedAt: string;
}

/** Canonical provider order: fetchAll iteration and every quota UI group. */
export const QUOTA_PROVIDER_IDS: readonly QuotaProviderId[] = ["kimi", "glm", "mimo", "deepseek"];

/**
 * Per-provider status-bar visibility. Persisted as the `statusBar` block inside
 * quota.json (full record on write; reads accept sparse maps too — an absent
 * key counts as visible); always held fully materialized in memory so consumers
 * never deal with partial records.
 */
export type QuotaVisibility = Record<QuotaProviderId, boolean>;

/** Manager page tabs — the quota view and the settings view live in one panel. */
export type ManagerTab = "quota" | "settings";

/** Switch the manager page to a tab; focusProvider scrolls one quota group into view. */
export interface ManagerNavigatePayload {
  tab: ManagerTab;
  focusProvider?: QuotaProviderId;
}

/** All-visible default used when quota.json carries no visibility block. */
export function defaultQuotaVisibility(): QuotaVisibility {
  return { kimi: true, glm: true, mimo: true, deepseek: true };
}

/**
 * Drop providers hidden from the status bar. Pure: the caller (status bar text,
 * tooltip, degraded check) renders only what the user chose to see; the quota
 * view itself never filters — it always shows all four groups so the toggles
 * stay reachable.
 */
export function filterQuotaSnapshotByVisibility(snapshot: QuotaSnapshot, visibility: QuotaVisibility): QuotaSnapshot {
  return {
    providers: snapshot.providers.filter((provider) => visibility[provider.providerId] !== false),
    fetchedAt: snapshot.fetchedAt,
  };
}

/** Canonical quota-window display order (status-bar segments, panel rows): 5h → weekly → monthly. */
export const QUOTA_WINDOW_ORDER: readonly QuotaWindowKind[] = ["5h", "weekly", "monthly"];

const QUOTA_PROVIDER_LABELS: Record<QuotaProviderId, string> = {
  kimi: "Kimi",
  glm: "GLM",
  mimo: "MiMo",
  deepseek: "DeepSeek",
};

/** Display name of a provider — also the group title before any snapshot arrives. */
export function quotaProviderLabel(id: QuotaProviderId): string {
  return QUOTA_PROVIDER_LABELS[id];
}

/** Boot payload of the quota view; focusProvider scrolls one group into view (MiMo config entry point). */
export interface QuotaInitPayload {
  snapshot: QuotaSnapshot | null;
  /** Current per-provider status-bar visibility (host-normalized full record). */
  visibility?: QuotaVisibility;
  focusProvider?: QuotaProviderId;
}

export type QuotaSegmentColor = "green" | "yellow" | "red" | "neutral";

/** Remaining-percent color band shared by the status bar and the quota panel: ≥60 green, 20–60 yellow, <20 red. */
export function remainingColor(remaining: number): QuotaSegmentColor {
  if (remaining >= 60) {
    return "green";
  }
  return remaining >= 20 ? "yellow" : "red";
}

/** Balance color band for absolute amounts (pay-as-you-go balances): >100 green, 20–100 yellow, <20 red. */
export function balanceColor(total: number): QuotaSegmentColor {
  if (total > 100) {
    return "green";
  }
  return total >= 20 ? "yellow" : "red";
}

/**
 * Remaining percent for display: prefer the API-provided value, else derive 100 − usedPercent
 * (one decimal); null when both are unknown (no data — never a fabricated number).
 */
export function deriveRemainingPercent(window: QuotaWindow): number | null {
  return (
    window.remainingPercent ?? (window.usedPercent !== null ? Math.round((100 - window.usedPercent) * 10) / 10 : null)
  );
}

const QUOTA_WINDOW_LABELS: Record<QuotaWindowKind, string> = {
  "5h": "5小时额度",
  weekly: "周额度",
  monthly: "月额度",
};

/** Chinese display label of a quota window kind (tooltips, panel rows). */
export function quotaWindowLabel(kind: QuotaWindowKind): string {
  return QUOTA_WINDOW_LABELS[kind];
}

/** Currency symbol for balance display; unknown codes fall back to a prefixed ISO code. */
export function quotaCurrencySymbol(currency: string): string {
  const symbols: Record<string, string> = { CNY: "¥", USD: "$" };
  return symbols[currency] ?? `${currency} `;
}

/** Reset-time line for display; null/garbage timestamps degrade to a fixed hint, never "Invalid Date". */
export function formatQuotaResetTime(iso: string | null): string {
  if (!iso) {
    return "重置时间未知";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "重置时间未知" : `重置于 ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

// ---------------------------------------------------------------------------
// Settings view contract — per-category tree auto-refresh polling plus the
// Coding Plan refresh interval. Consumed by BOTH the extension host
// (settingsStore read/write, autoRefreshScheduler, managerPanelHost) and the
// manager webview bundle (manager.html, 设置 tab), so the shapes, bounds and
// the normalizer live here as the single source of truth.
// ---------------------------------------------------------------------------

/** Tree sections that support timed auto-refresh polling, in settings-page display order. */
export const AUTO_REFRESH_CATEGORIES = ["config", "presets", "backups", "models", "plugins"] as const;
export type AutoRefreshCategory = (typeof AUTO_REFRESH_CATEGORIES)[number];

export interface AutoRefreshCategorySetting {
  enabled: boolean;
  /** Polling interval in seconds (1–3600); kept even when disabled so the input survives toggling. */
  intervalSeconds: number;
}

export interface AutoRefreshSettings {
  categories: Record<AutoRefreshCategory, AutoRefreshCategorySetting>;
  /** Coding Plan auto-refresh interval in seconds; 0 disables the cycle (quota.refreshSeconds semantics). */
  quotaRefreshSeconds: number;
}

export const AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS = 30;
export const AUTO_REFRESH_MIN_INTERVAL_SECONDS = 1;
export const AUTO_REFRESH_MAX_INTERVAL_SECONDS = 3600;
export const QUOTA_REFRESH_DEFAULT_SECONDS = 30;
export const QUOTA_REFRESH_MIN_SECONDS = 0;
export const QUOTA_REFRESH_MAX_SECONDS = 3600;

const AUTO_REFRESH_CATEGORY_LABELS: Record<AutoRefreshCategory, string> = {
  config: "配置",
  presets: "模板",
  backups: "备份",
  models: "模型",
  plugins: "插件",
};

/** Chinese display label of an auto-refresh category (settings page rows). */
export function autoRefreshCategoryLabel(category: AutoRefreshCategory): string {
  return AUTO_REFRESH_CATEGORY_LABELS[category];
}

/** Loose input accepted by the normalizer: config get() results and webview payloads alike. */
export interface AutoRefreshSettingsSource {
  categories?: Partial<Record<AutoRefreshCategory, { enabled?: unknown; intervalSeconds?: unknown }>>;
  quotaRefreshSeconds?: unknown;
}

function clampSeconds(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Validate + clamp arbitrary settings input into a well-formed AutoRefreshSettings:
 * non-numeric intervals fall back to defaults, out-of-range values clamp to the
 * bounds, enabled is strictly boolean. The same normalizer guards the host-side
 * message parse, the config read, and the webview form state.
 */
export function normalizeAutoRefreshSettings(
  source: AutoRefreshSettingsSource | null | undefined,
): AutoRefreshSettings {
  const categories = {} as Record<AutoRefreshCategory, AutoRefreshCategorySetting>;
  for (const category of AUTO_REFRESH_CATEGORIES) {
    const raw = source?.categories?.[category];
    categories[category] = {
      enabled: raw?.enabled === true,
      intervalSeconds: clampSeconds(
        raw?.intervalSeconds,
        AUTO_REFRESH_MIN_INTERVAL_SECONDS,
        AUTO_REFRESH_MAX_INTERVAL_SECONDS,
        AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
      ),
    };
  }
  return {
    categories,
    quotaRefreshSeconds: clampSeconds(
      source?.quotaRefreshSeconds,
      QUOTA_REFRESH_MIN_SECONDS,
      QUOTA_REFRESH_MAX_SECONDS,
      QUOTA_REFRESH_DEFAULT_SECONDS,
    ),
  };
}

/** Boot payload of the settings page; also pushed when the settings change outside the page. */
export interface SettingsInitPayload {
  settings: AutoRefreshSettings;
}
