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

/** Lean 模板列表 entry — display metadata only, no agent/category row data. */
export interface PresetListEntry {
  name: string;
  description?: string;
  createdAt: string;
  appliedAt: string | null;
}

/**
 * Structural subset of the core Preset record accepted by toPresetListEntries:
 * protocol stays core-free, so the mapper takes anything shaped like a preset.
 */
export interface PresetListSource {
  name: string;
  description?: string;
  createdAt: string;
  appliedAt?: string | null;
}

/** Project preset records into the lean list shape (drops row data the list view never renders). */
export function toPresetListEntries(presets: readonly PresetListSource[]): PresetListEntry[] {
  return presets.map((preset) => ({
    name: preset.name,
    ...(preset.description !== undefined ? { description: preset.description } : {}),
    createdAt: preset.createdAt,
    appliedAt: preset.appliedAt ?? null,
  }));
}

export type ExtToWebview =
  | { type: "init"; payload: WebviewInitPayload }
  /** Sent when building/sending the init payload failed (e.g. listModels threw): replaces the boot screen with the error. */
  | { type: "initFailed"; payload: { error: string } }
  | { type: "modelsUpdated"; payload: { models: ModelOption[] } }
  | { type: "result"; payload: { action: "save" | "apply"; ok: boolean; error?: string } }
  /** 模板 tab default view: the preset list rides along on panel boot AND is re-pushed
   *  on preset-tab navigation and after every preset save (renames change the list). */
  | { type: "presetList"; payload: { presets: PresetListEntry[] } }
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
  | { type: "settingsSaved"; payload: { ok: boolean; error?: string } }
  /** 配置 tab boot payload AND external-change push (watcher-driven config re-sync). */
  | { type: "configInit"; payload: ConfigInitPayload }
  /** Reply to configSetModel: ok carries no error, !ok carries the friendly Chinese message. */
  | {
      type: "configModelSaved";
      payload: { ok: boolean; section: "agents" | "categories"; name: string; error?: string };
    }
  /** OpenCode tab boot payload AND external-change push (boot + watcher-driven re-sync + post-write re-push). */
  | { type: "opencodeInit"; payload: OpencodeSettingsPayload }
  /** Reply to opencodeSetSetting: ok echoes the key, !ok carries the friendly Chinese message. */
  | { type: "opencodeSettingSaved"; payload: { ok: boolean; key: string; error?: string } }
  /** Reply to omoSetSetting: ok echoes the key, !ok carries the friendly Chinese message. */
  | { type: "omoSettingSaved"; payload: { ok: boolean; key: string; error?: string } };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "dirty"; payload: boolean }
  | { type: "cancel" }
  | { type: "save"; payload: { name: string; description?: string; rows: PresetRow[]; apply: boolean } }
  /** 模板 tab list-view click: begin (or switch to) the named preset's edit session (null = new). */
  | { type: "presetEdit"; payload?: { name: string | null } }
  /** Manual refresh from the quota view; providerId omitted (or undefined) means refresh all providers. */
  | { type: "quotaRefresh"; payload?: { providerId?: QuotaProviderId } }
  | { type: "quotaSaveMimoCookie"; payload: { cookie: string } }
  /** Toggle one provider's status-bar visibility (persisted into quota.json by the host). */
  | { type: "quotaSetStatusBar"; payload: { providerId: QuotaProviderId; visible: boolean } }
  /** Answer to quotaPing — proves the webview's JS context is still alive. */
  | { type: "pong" }
  /** Persist the whole settings form (idempotent full-object save; values re-normalized host-side). */
  | { type: "settingsSave"; payload: { settings: AutoRefreshSettings } }
  /** 配置 tab in-page edit: write one agent/category model assignment into the live config target. */
  | {
      type: "configSetModel";
      payload: { section: "agents" | "categories"; name: string; model: string; variant: string | null };
    }
  /** OpenCode tab in-page edit: write (null = remove the key) one OPENCODE_SETTINGS entry into opencode.json[c]. */
  | { type: "opencodeSetSetting"; payload: { key: string; value: OpencodeSettingValue } }
  /** OMO tab feature-settings edit: write (null = remove the key) one OMO_MISC_SETTINGS entry into the agent config. */
  | { type: "omoSetSetting"; payload: { key: string; value: OmoSettingValue } };

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

/**
 * Manager page tabs (display order: OMO · OpenCode · 额度 · 设置 · 模板 · 技能). The "config"
 * id KEEPS its historical name — persisted webview state and e2e assertions depend on it;
 * only its display label changes to OMO. "skills" data rides configInit (no own channel).
 */
export type ManagerTab = "config" | "opencode" | "quota" | "settings" | "preset" | "skills";

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

// ---------------------------------------------------------------------------
// Config view contract — the live agent/category assignment editor plus the
// read-only skills list (配置 tab). SkillSummary lives here because the webview
// must not import core (node:fs dependencies); core imports the TYPE from this
// module (same pattern as the quota shapes above).
// ---------------------------------------------------------------------------

/** One discovered skill for the config tab's read-only list (name + SKILL.md frontmatter description). */
export interface SkillSummary {
  name: string;
  /** SKILL.md frontmatter description line; "" when absent/unparseable. */
  description: string;
  scope: "global" | "project";
  /** Display label of the skills dir this skill was found in (e.g. "~/.agents/skills"). */
  locationLabel: string;
}

/** Config-tab boot payload: live assignments + model options + skills + the write target. */
export interface ConfigInitPayload {
  rows: PresetRow[];
  models: ModelOption[];
  skills: SkillSummary[];
  target: { kind: "omo" | "legacy"; path: string };
  /** Current OMO misc feature values (null = not set in file); powers the OMO tab's 功能设置 section. */
  omo: OmoMiscValues;
}

// ---------------------------------------------------------------------------
// OMO misc feature settings + OpenCode settings contracts — data-driven
// descriptor tables shared by the webview renderers (OMO/OpenCode tabs) and the
// host-side validators, so the key set, kinds and bounds can never drift
// between the two halves. Same dual-consumer pattern as the quota shapes above.
// ---------------------------------------------------------------------------

/** One oh-my-openagent misc feature setting (OMO tab 功能设置 section). */
export interface OmoMiscSetting {
  key: string;
  /** Key path inside the agent config, relative to the target's sectionPath prefix. */
  path: string[];
  kind: "boolean" | "number" | "enum" | "stringList" | "orderedList" | "enumChips" | "shallowObject" | "modelCatalog";
  label: string;
  hint?: string;
  /** Chinese section label used to group rows in the OMO tab. */
  group: string;
  /** Inclusive integer bounds of the number kind (defaults: 0..100); single source for the host validator AND the webview pre-check. */
  min?: number;
  max?: number;
  /** Runtime default shown when the file does not set the key (null in {@link OmoMiscValues}); scalar kinds only — the new kinds default to "empty". */
  default?: boolean | number;
  /** Selectable values for the enumChips (fixed multi-select) and enum (single-select) kinds. */
  options?: string[];
  /** Field schemas of the shallowObject kind (Wave-1 type reused, no duplicate shape). */
  fields?: OpencodeSettingField[];
  /**
   * plugin (default) = the key lives under the sectionPath prefix (omo `[opencode]` block /
   * legacy top level); shared = the key lives at the TOP LEVEL of the target file for BOTH
   * targets — never under `[opencode]` (e.g. the `models` catalog both generations share).
   */
  scope?: "plugin" | "shared";
}

/**
 * High-frequency oh-my-openagent feature toggles (paths are the SAME keys for the
 * omo 5 `[opencode]` block and the legacy 4.x top level; only the sectionPath
 * prefix differs — see core/omoSettings.ts).
 */
export const OMO_MISC_SETTINGS: readonly OmoMiscSetting[] = [
  {
    key: "telemetry",
    path: ["telemetry"],
    kind: "boolean",
    label: "启用遥测",
    hint: "关闭后不再上报匿名使用数据",
    group: "遥测",
    default: true,
  },
  {
    key: "teamMode",
    path: ["team_mode", "enabled"],
    kind: "boolean",
    label: "团队模式",
    hint: "启用 oh-my-openagent 的 agent team 协作",
    group: "团队模式",
    default: false,
  },
  {
    key: "teamTmuxVisualization",
    path: ["team_mode", "tmux_visualization"],
    kind: "boolean",
    label: "团队模式可视化",
    hint: "以 tmux 窗格展示 team 成员（需先安装 tmux）",
    group: "团队模式",
    default: false,
  },
  {
    key: "tmuxEnabled",
    path: ["tmux", "enabled"],
    kind: "boolean",
    label: "tmux 集成",
    group: "团队模式",
    default: false,
  },
  {
    key: "hashlineEdit",
    path: ["hashline_edit"],
    kind: "boolean",
    label: "行内编辑（hashline）",
    group: "实验特性",
    default: false,
  },
  {
    key: "taskSystem",
    path: ["experimental", "task_system"],
    kind: "boolean",
    label: "任务系统",
    group: "实验特性",
    default: false,
  },
  {
    key: "sisyphusDisabled",
    path: ["sisyphus_agent", "disabled"],
    kind: "boolean",
    label: "禁用 Sisyphus 编排",
    group: "编排",
    default: false,
  },
  {
    key: "sisyphusPlanner",
    path: ["sisyphus_agent", "planner_enabled"],
    kind: "boolean",
    label: "Sisyphus 规划器",
    group: "编排",
    default: true,
  },
  {
    key: "sisyphusDefaultBuilder",
    path: ["sisyphus_agent", "default_builder_enabled"],
    kind: "boolean",
    label: "Sisyphus 默认构建器",
    group: "编排",
    default: false,
  },
  {
    key: "sisyphusReplacePlan",
    path: ["sisyphus_agent", "replace_plan"],
    kind: "boolean",
    label: "Sisyphus 替换计划",
    group: "编排",
    default: true,
  },
  {
    key: "sisyphusTdd",
    path: ["sisyphus_agent", "tdd"],
    kind: "boolean",
    label: "Sisyphus 强制 TDD",
    group: "编排",
    default: true,
  },
  {
    key: "runtimeFallback",
    path: ["runtime_fallback", "enabled"],
    kind: "boolean",
    label: "运行时回退",
    group: "稳定性",
    default: false,
  },
  {
    key: "runtimeFallbackParams",
    path: ["runtime_fallback"],
    kind: "shallowObject",
    label: "回退细参",
    group: "稳定性",
    fields: [
      { key: "max_fallback_attempts", kind: "number", label: "最大回退次数", min: 1, max: 20, integer: true },
      { key: "cooldown_seconds", kind: "number", label: "冷却秒数", min: 1, max: 3600, integer: true },
      { key: "timeout_seconds", kind: "number", label: "超时秒数", min: 1, max: 600, integer: true },
      { key: "notify_on_fallback", kind: "boolean", label: "回退时通知" },
      { key: "restore_primary_after_cooldown", kind: "boolean", label: "冷却后恢复主模型" },
    ],
  },
  {
    key: "disabledAgents",
    path: ["disabled_agents"],
    kind: "enumChips",
    // Spread of the canonical constant: options is a mutable string[] while KNOWN_AGENTS
    // is readonly — the values still have a single source (no literal duplication).
    options: [...KNOWN_AGENTS],
    label: "停用智能体",
    hint: "勾选的智能体将被停用",
    group: "智能体开关",
  },
  {
    key: "omoModels",
    path: ["models"],
    kind: "modelCatalog",
    scope: "shared",
    label: "模型别名目录",
    hint: "别名可在智能体模型中直接引用（如 kimi-max）",
    group: "模型目录",
  },
  {
    key: "defaultMode",
    path: ["default_mode"],
    kind: "shallowObject",
    label: "默认模式",
    group: "默认模式",
    fields: [
      { key: "ultrawork", kind: "boolean", label: "超级工作模式" },
      { key: "goal", kind: "boolean", label: "目标循环" },
    ],
  },
  {
    key: "disableOmoEnv",
    path: ["experimental", "disable_omo_env"],
    kind: "boolean",
    label: "关闭 OMO 环境变量",
    hint: "关闭注入的 OMO 环境变量可提升 prompt 缓存命中",
    group: "实验特性",
  },
  {
    key: "aggressiveTruncation",
    path: ["experimental", "aggressive_truncation"],
    kind: "boolean",
    label: "激进上下文截断",
    group: "实验特性",
  },
  {
    key: "truncateAllToolOutputs",
    path: ["experimental", "truncate_all_tool_outputs"],
    kind: "boolean",
    label: "截断全部工具输出",
    group: "实验特性",
  },
  {
    key: "backgroundConcurrency",
    path: ["background_task", "defaultConcurrency"],
    kind: "number",
    label: "后台任务并发数",
    hint: "0 = 不限",
    group: "编排",
    min: 0,
    max: 100,
    default: 5,
  },
  {
    key: "disabledMcps",
    path: ["disabled_mcps"],
    kind: "enumChips",
    options: ["websearch", "context7", "grep_app", "lsp", "codegraph"],
    label: "停用内置 MCP",
    group: "MCP 与命令",
  },
  {
    key: "disabledCommands",
    path: ["disabled_commands"],
    kind: "enumChips",
    options: ["goal", "refactor", "ulw-execute", "stop-continuation", "remove-ai-slops", "hyperplan"],
    label: "停用内置命令",
    hint: "命令名受 schema 严格枚举校验",
    group: "MCP 与命令",
  },
  {
    key: "browserAutomation",
    path: ["browser_automation_engine", "provider"],
    kind: "enum",
    options: ["playwright", "agent-browser", "dev-browser", "playwright-cli"],
    label: "浏览器自动化引擎",
    group: "引擎后端",
  },
  {
    key: "websearchProvider",
    path: ["websearch", "provider"],
    kind: "enum",
    options: ["exa", "tavily"],
    label: "网页搜索后端",
    group: "引擎后端",
  },
  {
    key: "gitMaster",
    path: ["git_master"],
    kind: "shallowObject",
    label: "Git 提交署名",
    group: "Git",
    fields: [
      { key: "commit_footer", kind: "boolean", label: "提交脚注", default: true },
      { key: "include_co_authored_by", kind: "boolean", label: "共同作者署名", default: true },
    ],
  },
  {
    key: "tmuxParams",
    path: ["tmux"],
    kind: "shallowObject",
    label: "tmux 布局参数",
    group: "团队模式",
    fields: [
      {
        key: "layout",
        kind: "enum",
        label: "布局",
        options: ["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"],
      },
      { key: "main_pane_size", kind: "number", label: "主窗格占比", min: 20, max: 80, integer: true, default: 60 },
      { key: "isolation", kind: "enum", label: "隔离方式", options: ["inline", "window", "session"] },
    ],
  },
  {
    key: "teamModeLimits",
    path: ["team_mode"],
    kind: "shallowObject",
    label: "Team 规模上限",
    hint: "并行数不应超过成员总数（运行时自校）",
    group: "团队模式",
    fields: [
      { key: "max_parallel_members", kind: "number", label: "最大并行成员", min: 1, max: 8, integer: true, default: 4 },
      { key: "max_members", kind: "number", label: "成员总数上限", min: 1, max: 8, integer: true, default: 8 },
      {
        key: "max_wall_clock_minutes",
        kind: "number",
        label: "最大运行分钟数",
        min: 1,
        max: 1440,
        integer: true,
        default: 120,
      },
      {
        key: "max_member_turns",
        kind: "number",
        label: "成员最大轮次",
        min: 1,
        max: 10000,
        integer: true,
        default: 500,
      },
    ],
  },
  {
    key: "agentOrder",
    path: ["agent_order"],
    kind: "orderedList",
    label: "智能体顺序",
    hint: "未识别名称运行时忽略",
    group: "智能体开关",
  },
];

/** Current OMO misc values; null = the file does not set the key (UI shows the descriptor default). */
export type OmoMiscValues = Record<string, OmoSettingValue>;

/** Max length of free-text opencode string settings (username); single source for the host validator AND the webview pre-check. */
export const OPENCODE_STRING_VALUE_MAX_LENGTH = 64;

/**
 * Max length of a tui.json theme name after trimming. Single source for core's
 * isValidTuiTheme (tuiSettings.ts) AND the webview's tuiTheme pre-check — the
 * bound is a deliberate contract, not a coincidental equality with the string bound.
 */
export const TUI_THEME_MAX_LENGTH = 64;

/**
 * The 15 per-tool permission keys opencode understands, in importance order.
 * Single source of truth for the permissionTools kind's validator, the panel's
 * tool rows and the aggregate reader (same pattern as KNOWN_AGENTS).
 */
export const OPENCODE_PERMISSION_TOOLS: readonly string[] = [
  "bash",
  "edit",
  "read",
  "glob",
  "grep",
  "list",
  "task",
  "skill",
  "lsp",
  "webfetch",
  "websearch",
  "todowrite",
  "question",
  "external_directory",
  "doom_loop",
];

/** stringList / orderedList value: an ordered list of short string entries (rule file paths, agent_order, …). */
export type StringListValue = string[];

/** shallowObject value: descriptor-field key → leaf value (null = field absent in file; string leaves come from enum fields). */
export type ShallowObjectValue = Record<string, boolean | number | string | null>;

/** permissionTools value: tool name → action (null = remove that tool's key). */
export type PermissionToolsValue = Record<string, "allow" | "ask" | "deny" | null>;

/** mcpServers write value: server name → disabled flag (snapshot diff semantics, see opencodeSettingEdits). */
export type McpServersValue = Record<string, boolean>;

/** modelCatalog value: alias → model binding; a null entry marks "remove that alias" (UI deletion intent only). */
export type ModelCatalogValue = Record<string, { model: string; reasoning: string | null } | null>;

/** One record field value: string (text/multiline/enum/model), boolean, string list, or null (= field unset). */
export type RecordFieldValue = string | boolean | string[] | null;

/**
 * One named record entry (command/formatter/lsp): field key → value. Reads omit
 * fields failing their kind (never null them), so a broken entry stays repairable.
 */
export type RecordEntryValue = Record<string, RecordFieldValue>;

/** recordEditor write value: name → entry (null entry = delete that name; reads never produce null). */
export type RecordEditorValue = Record<string, RecordEntryValue | null>;

/** One field schema of a recordEditor descriptor (a leaf inside each named entry). */
export interface RecordFieldDef {
  key: string;
  kind: "text" | "multiline" | "boolean" | "stringList" | "enum" | "model";
  label: string;
  hint?: string;
  /** Selectable values of the enum kind (leaf values outside them are rejected). */
  options?: string[];
  /** Field must be present as a non-empty trimmed string (write-side gate). */
  required?: boolean;
  /** Length bound of text (default 256) and multiline (default 8000) fields, after trimming. */
  maxLen?: number;
  /** Entry cap of a stringList field (default 8; entry rules reuse the shared stringList bounds). */
  maxEntries?: number;
}

/**
 * The 8 reasoning levels a modelCatalog alias entry may pin. Single source for the
 * omoSettings validator and the webview reasoning dropdown (same pattern as VARIANTS).
 */
export const OMO_REASONING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
];

/** One field schema of a shallowObject-kind descriptor (a leaf key inside the object). */
export interface OpencodeSettingField {
  key: string;
  /** boolean and number leaves are scalars; enum leaves must be one of the listed options. */
  kind: "boolean" | "number" | "enum";
  label: string;
  hint?: string;
  /** Inclusive bounds of the number kind (absent = unbounded). */
  min?: number;
  max?: number;
  /** Reject non-integers when true; decimals allowed exactly when this is not set. */
  integer?: boolean;
  /** Selectable values of the enum kind (the leaf value must be one of them). */
  options?: string[];
  /** Documented default shown when the file does not set the field. */
  default?: boolean | number;
}

/** One opencode.json setting visualized in the OpenCode tab. */
export interface OpencodeSetting {
  key: string;
  /** Key path inside opencode.json[c] (or the `file` target when one is set). */
  path: string[];
  kind:
    | "model"
    | "enum"
    | "tristate"
    | "boolean"
    | "string"
    | "number"
    | "providers"
    | "stringList"
    | "orderedList"
    | "enumChips"
    | "shallowObject"
    | "permissionTools"
    | "mcpServers"
    | "recordEditor"
    | "recordMaster";
  label: string;
  hint?: string;
  /** Selectable values for the enum kind. */
  options?: string[];
  /** Chinese section label used to group rows in the OpenCode tab (模型 / 行为 / 其他 / …). */
  group: string;
  /** Documented default shown as a hint when the file does not set the key. */
  default?: boolean | string;
  /** Inclusive bounds of the number kind (absent = unbounded). */
  min?: number;
  max?: number;
  /** Reject non-integers when true; decimals allowed exactly when this is not set. */
  integer?: boolean;
  /** Field schemas of the shallowObject kind. */
  fields?: OpencodeSettingField[];
  /**
   * recordEditor metadata: entry field schemas plus name rules. Defaults:
   * namePattern /^[A-Za-z0-9._-]+$/, nameMaxLen 64, maxEntries 32.
   */
  record?: {
    fields: RecordFieldDef[];
    /** Name charset source (compiled host-side); default /^[A-Za-z0-9._-]+$/. */
    namePattern?: string;
    nameMaxLen?: number;
    maxEntries?: number;
  };
  /** Non-opencode.json target file; "tui" routes this descriptor's reads/writes to configDir/tui.json. */
  file?: "tui";
}

/**
 * High-frequency opencode.json keys (issue traffic + doc coverage). Deprecated keys
 * (theme/keybinds/tui/layout/mode/autoshare) are deliberately absent from opencode.json —
 * opencode silently drops them on load, so writing them is a no-op (design-doc red
 * line); the TUI theme rides the separate tui.json face via the tuiTheme descriptor
 * (file: "tui") instead.
 */
export const OPENCODE_SETTINGS: readonly OpencodeSetting[] = [
  {
    key: "model",
    path: ["model"],
    kind: "model",
    label: "默认模型",
    hint: "未单独指定模型时使用的全局模型",
    group: "模型",
  },
  {
    key: "smallModel",
    path: ["small_model"],
    kind: "model",
    label: "小模型",
    hint: "轻量后台任务（如标题生成）使用的模型",
    group: "模型",
  },
  {
    key: "defaultAgent",
    path: ["default_agent"],
    kind: "enum",
    label: "默认智能体",
    options: ["build", "plan"],
    hint: "仅列内置 primary agent；自定义 primary agent 需在配置文件中手动填写",
    group: "行为",
  },
  {
    key: "share",
    path: ["share"],
    kind: "enum",
    label: "会话分享",
    options: ["manual", "auto", "disabled"],
    group: "行为",
  },
  {
    key: "autoupdate",
    path: ["autoupdate"],
    kind: "tristate",
    label: "自动更新",
    hint: "true=自动安装更新，false=关闭，notify=仅提醒",
    group: "行为",
  },
  {
    key: "snapshot",
    path: ["snapshot"],
    kind: "boolean",
    label: "文件快照",
    hint: "关闭后将无法撤销文件变更",
    group: "行为",
    default: true,
  },
  {
    key: "username",
    path: ["username"],
    kind: "string",
    label: "用户名",
    group: "其他",
  },
  {
    key: "disabledProviders",
    path: ["disabled_providers"],
    kind: "providers",
    label: "禁用的供应商",
    hint: "被禁用的供应商不再出现在模型选择中（优先于启用列表）",
    group: "其他",
  },
  {
    key: "agentBuildModel",
    path: ["agent", "build", "model"],
    kind: "model",
    label: "build 智能体模型",
    hint: "opencode 原生智能体覆写，与 OMO 的智能体配置是两套体系",
    group: "模型",
  },
  {
    key: "agentPlanModel",
    path: ["agent", "plan", "model"],
    kind: "model",
    label: "plan 智能体模型",
    hint: "opencode 原生智能体覆写，与 OMO 的智能体配置是两套体系",
    group: "模型",
  },
  {
    key: "permissionShorthand",
    path: ["permission"],
    kind: "enum",
    label: "全局权限",
    options: ["allow", "ask", "deny"],
    hint: "读写规则见下方按工具设置",
    group: "权限",
  },
  {
    key: "permissionTools",
    path: ["permission"],
    kind: "permissionTools",
    label: "按工具权限",
    group: "权限",
  },
  {
    key: "instructions",
    path: ["instructions"],
    kind: "stringList",
    label: "规则文件",
    hint: "项目级配置文件会按并集叠加",
    group: "规则文件",
  },
  {
    key: "mcpServers",
    path: ["mcp"],
    kind: "mcpServers",
    label: "MCP 服务器",
    group: "MCP 服务器",
  },
  {
    key: "compaction",
    path: ["compaction"],
    kind: "shallowObject",
    label: "上下文压缩",
    group: "上下文",
    fields: [
      { key: "auto", kind: "boolean", label: "自动压缩", default: true },
      { key: "prune", kind: "boolean", label: "修剪旧消息", default: false },
      { key: "tail_turns", kind: "number", label: "保留尾部轮次", min: 0, max: 100, integer: true, default: 2 },
    ],
  },
  {
    key: "agentBuildDisable",
    path: ["agent", "build", "disable"],
    kind: "boolean",
    label: "禁用 build 智能体",
    group: "智能体",
  },
  {
    key: "agentBuildTemperature",
    path: ["agent", "build", "temperature"],
    kind: "number",
    label: "build 温度",
    hint: "0–2，支持小数",
    min: 0,
    max: 2,
    group: "智能体",
  },
  {
    key: "agentPlanDisable",
    path: ["agent", "plan", "disable"],
    kind: "boolean",
    label: "禁用 plan 智能体",
    group: "智能体",
  },
  {
    key: "agentPlanTemperature",
    path: ["agent", "plan", "temperature"],
    kind: "number",
    label: "plan 温度",
    hint: "0–2，支持小数",
    min: 0,
    max: 2,
    group: "智能体",
  },
  {
    key: "agentGeneralModel",
    path: ["agent", "general", "model"],
    kind: "model",
    label: "general 智能体模型",
    hint: "opencode 原生智能体覆写，与 OMO 的智能体配置是两套体系",
    group: "智能体",
  },
  {
    key: "agentExploreModel",
    path: ["agent", "explore", "model"],
    kind: "model",
    label: "explore 智能体模型",
    hint: "opencode 原生智能体覆写，与 OMO 的智能体配置是两套体系",
    group: "智能体",
  },
  {
    key: "tuiTheme",
    path: ["theme"],
    kind: "string",
    file: "tui",
    label: "TUI 主题",
    hint: "示例：opencode、catppuccin、tokyo-night；写入 tui.json",
    group: "终端界面",
  },
  {
    key: "logLevel",
    path: ["logLevel"],
    kind: "enum",
    label: "日志级别",
    options: ["DEBUG", "INFO", "WARN", "ERROR"],
    group: "高级",
  },
  {
    key: "shell",
    path: ["shell"],
    kind: "string",
    label: "Shell 路径",
    hint: "系统自动探测，仅必要时覆盖",
    group: "高级",
  },
  {
    key: "subagentDepth",
    path: ["subagent_depth"],
    kind: "number",
    label: "子代理深度",
    hint: "0=禁止所有子代理",
    min: 0,
    max: 16,
    integer: true,
    group: "高级",
  },
  {
    key: "toolOutput",
    path: ["tool_output"],
    kind: "shallowObject",
    label: "工具输出上限",
    group: "终端与输出",
    fields: [
      { key: "max_lines", kind: "number", label: "最大行数", integer: true, default: 2000 },
      { key: "max_bytes", kind: "number", label: "最大字节数", integer: true, default: 51200 },
    ],
  },
  {
    key: "attachmentImage",
    path: ["attachment", "image"],
    kind: "shallowObject",
    label: "图片附件处理",
    group: "终端与输出",
    fields: [
      { key: "auto_resize", kind: "boolean", label: "自动缩放", default: true },
      { key: "max_width", kind: "number", label: "最大宽度", integer: true, default: 2000 },
      { key: "max_height", kind: "number", label: "最大高度", integer: true, default: 2000 },
      { key: "max_base64_bytes", kind: "number", label: "Base64 字节上限", integer: true, default: 5242880 },
    ],
  },
  {
    key: "watcherIgnore",
    path: ["watcher", "ignore"],
    kind: "stringList",
    label: "监视忽略",
    hint: "glob 列表",
    group: "高级",
  },
  {
    key: "command",
    path: ["command"],
    kind: "recordEditor",
    label: "自定义命令",
    group: "命令",
    record: {
      fields: [
        {
          key: "template",
          kind: "multiline",
          label: "模板",
          required: true,
          hint: "支持 $ARGUMENTS 等模板变量",
        },
        { key: "description", kind: "text", label: "描述" },
        { key: "agent", kind: "enum", label: "智能体", options: ["build", "plan", "general", "explore"] },
        { key: "model", kind: "model", label: "模型" },
        { key: "subtask", kind: "boolean", label: "子代理任务", hint: "作为子代理任务运行" },
      ],
    },
  },
  {
    key: "formatterMaster",
    path: ["formatter"],
    kind: "recordMaster",
    label: "内置格式化器",
    hint: "true=启用内置 false=全部关闭",
    group: "格式化",
  },
  {
    key: "formatterEntries",
    path: ["formatter"],
    kind: "recordEditor",
    label: "格式化器",
    group: "格式化",
    record: {
      fields: [
        { key: "disabled", kind: "boolean", label: "停用" },
        { key: "command", kind: "stringList", label: "命令" },
        { key: "extensions", kind: "stringList", label: "扩展名", hint: "文件扩展名如 ts" },
      ],
    },
  },
  {
    key: "lspMaster",
    path: ["lsp"],
    kind: "recordMaster",
    label: "内置语言服务器",
    hint: "true=启用内置 false=全部关闭",
    group: "LSP",
  },
  {
    key: "lspEntries",
    path: ["lsp"],
    kind: "recordEditor",
    label: "语言服务器",
    group: "LSP",
    record: {
      fields: [
        { key: "disabled", kind: "boolean", label: "停用" },
        { key: "command", kind: "stringList", label: "命令" },
        { key: "extensions", kind: "stringList", label: "扩展名", hint: "文件扩展名如 ts" },
      ],
    },
  },
];

/** One OpenCode setting value; null = key absent (「未设置」→ remove edit). */
export type OpencodeSettingValue =
  | string
  | boolean
  | number
  | null
  | StringListValue
  | ShallowObjectValue
  | PermissionToolsValue
  | McpServersValue
  | RecordEditorValue;

/** One OMO tab setting value; null = remove op (恢复默认) — the shape follows the descriptor kind. */
export type OmoSettingValue =
  boolean | number | string | null | StringListValue | ShallowObjectValue | ModelCatalogValue;

/**
 * Read/write-split permission aggregate for the OpenCode tab payload: the string
 * shorthand when `permission` is a string, the per-tool actions for the simple
 * object form, and the tool names whose values are hand-written pattern objects
 * (protected — the UI badges them as 高级规则 and never offers a dropdown).
 */
export interface OpencodePermissionState {
  shorthand: "allow" | "ask" | "deny" | null;
  tools: PermissionToolsValue;
  advancedTools: string[];
}

/**
 * Read/write-split record aggregate for the OpenCode tab payload: the boolean master
 * form (mode "boolean"), the named-entry form (mode "entries"), or absent/garbage
 * (mode "unset"). command has no master, so it is only ever entries/unset.
 */
export interface RecordAggregate {
  mode: "unset" | "boolean" | "entries";
  booleanValue: boolean | null;
  entries: Record<string, RecordEntryValue>;
}

/** The OpenCode tab payload's record slot: one aggregate per recordEditor path (命令/格式化/LSP). */
export interface OpencodeRecordStates {
  command: RecordAggregate;
  formatter: RecordAggregate;
  lsp: RecordAggregate;
}

/** Boot/refresh payload of the OpenCode tab: current values + the config file path + model options. */
export interface OpencodeSettingsPayload {
  values: Record<string, OpencodeSettingValue>;
  configPath: string;
  models: ModelOption[];
  /** Permission aggregate (read path of the 权限 group; writes go through permissionTools/shorthand keys). */
  permission: OpencodePermissionState;
  /** Declared MCP servers with their disabled flags (read path of the MCP 服务器 group). */
  mcp: { name: string; disabled: boolean }[];
  /** The standalone tui.json face: current theme + file path shown in the 终端界面 group. */
  tui: { theme: string | null; path: string };
  /** Record aggregates (read path of the 命令/格式化/LSP groups; writes go through the record descriptors). */
  records: OpencodeRecordStates;
}
