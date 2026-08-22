import * as defaultFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type QuotaProviderId = "kimi" | "glm" | "mimo";
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
}

export interface QuotaSnapshot {
  providers: ProviderQuota[];
  fetchedAt: string;
}

export interface QuotaServiceOptions {
  /** opencode credential store; defaults to $XDG_DATA_HOME/opencode/auth.json (~/.local/share/opencode/auth.json). */
  authFilePath?: string;
  /** Extension-owned quota config (<configDir>/quota.json) carrying the MiMo dashboard cookie. */
  quotaConfigPath?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  fs?: typeof import("node:fs");
}

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const MIMO_API_BASE = "https://platform.xiaomimimo.com/api/v1";

const KIMI_PLAN_LEVELS: Record<string, string> = {
  LEVEL_BASIC: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
  LEVEL_STANDARD: "Vivace",
};

/** GLM limit `unit` enum: 1=天 3=小时 5=分钟 6=周（0=未知），来自 open.bigmodel.cn 配额接口。 */
const GLM_UNIT_DAYS = 1;
const GLM_UNIT_HOURS = 3;
const GLM_UNIT_WEEKS = 6;

function kimiWindowKind(timeUnit: unknown, duration: number | null): QuotaWindowKind | null {
  if (typeof timeUnit !== "string") {
    return null;
  }
  if (timeUnit === "TIME_UNIT_MINUTE" && duration === 300) {
    return "5h";
  }
  if (timeUnit === "TIME_UNIT_HOUR" && duration === 5) {
    return "5h";
  }
  if (timeUnit === "TIME_UNIT_DAY" && duration === 7) {
    return "weekly";
  }
  if (timeUnit === "TIME_UNIT_WEEK" && duration === 1) {
    return "weekly";
  }
  if (timeUnit === "TIME_UNIT_DAY" && duration === 30) {
    return "monthly";
  }
  if (timeUnit === "TIME_UNIT_MONTH" && duration === 1) {
    return "monthly";
  }
  return null;
}

function glmWindowKind(unit: number | null, number: number | null): QuotaWindowKind | null {
  if (unit === GLM_UNIT_HOURS && number === 5) {
    return "5h";
  }
  if (unit === GLM_UNIT_WEEKS) {
    return "weekly";
  }
  if (unit === GLM_UNIT_DAYS && number === 7) {
    return "weekly";
  }
  if (unit === GLM_UNIT_DAYS && number !== null && number >= 28 && number <= 31) {
    return "monthly";
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percent(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) {
    return null;
  }
  return Math.round((part / whole) * 1000) / 10;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function toIsoOrNull(value: unknown): string | null {
  const num = toFiniteNumber(value);
  if (num !== null && num > 1_000_000_000) {
    const ms = num > 1e12 ? num : num * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function readAuthEntries(authFilePath: string, fsMod: typeof defaultFs): Record<string, { type?: string; key?: string; access?: string; refresh?: string }> {
  try {
    const parsed = JSON.parse(fsMod.readFileSync(authFilePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, { type?: string; key?: string }>) : {};
  } catch {
    return {};
  }
}

function bearerKey(entry: { type?: string; key?: string } | undefined): string | null {
  const key = entry?.key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Extract the two cookies MiMo's dashboard needs; anything else is dropped. */
export function normalizeMimoCookie(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.replace(/^Cookie:\s*/i, "").trim();
  const parts = cleaned
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /^(api-platform_serviceToken|userId|api-platform_ph|api-platform_slh)=/.test(part));
  const names = new Set(parts.map((part) => part.split("=")[0]));
  if (!names.has("api-platform_serviceToken") || !names.has("userId")) {
    return null;
  }
  return parts.join("; ");
}

function readMimoCookie(quotaConfigPath: string, fsMod: typeof defaultFs): string | null {
  try {
    const parsed = JSON.parse(fsMod.readFileSync(quotaConfigPath, "utf8"));
    const cookie = (parsed as { mimo?: { cookie?: unknown } })?.mimo?.cookie;
    return normalizeMimoCookie(cookie);
  } catch {
    return null;
  }
}

function emptyProvider(id: QuotaProviderId, label: string): ProviderQuota {
  return { providerId: id, label, plan: null, windows: [], balances: null, configured: false, error: null };
}

function errorProvider(base: ProviderQuota, message: string): ProviderQuota {
  return { ...base, windows: [], error: message };
}

/** The tightest remaining percentage across a provider's windows (null when nothing reports). */
export function worstRemaining(quota: ProviderQuota): number | null {
  let worst: number | null = null;
  for (const window of quota.windows) {
    const remaining = window.remainingPercent ?? (window.usedPercent !== null ? 100 - window.usedPercent : null);
    if (remaining === null) {
      continue;
    }
    worst = worst === null ? remaining : Math.min(worst, remaining);
  }
  return worst;
}

const WINDOW_SHORT_LABELS: Record<QuotaWindowKind, string> = { "5h": "5h", weekly: "7d", monthly: "30d" };
const WINDOW_DISPLAY_ORDER: readonly QuotaWindowKind[] = ["5h", "weekly", "monthly"];

export type QuotaSegmentColor = "green" | "yellow" | "red" | "neutral";

export interface QuotaBarSegment {
  text: string;
  color: QuotaSegmentColor;
}

export interface QuotaBar {
  segments: QuotaBarSegment[];
}

/** Color band by remaining percent: ≥60 green, 20–60 yellow, <20 red. */
export function remainingColor(remaining: number): QuotaSegmentColor {
  if (remaining >= 60) {
    return "green";
  }
  return remaining >= 20 ? "yellow" : "red";
}

/**
 * Pure status-bar builder: one segment per (provider, window) so each window gets its own
 * color — "Kimi 100%/5h", "72%/7d", "GLM 91%/5h" in 5h → 7d → 30d order (remaining percent,
 * provider name only on its first segment). Errored providers collapse to a neutral "?" segment.
 */
export function formatQuotaBar(snapshot: QuotaSnapshot): QuotaBar {
  const segments: QuotaBarSegment[] = [];
  for (const provider of snapshot.providers) {
    if (provider.error !== null) {
      segments.push({ text: `${provider.label} ?`, color: "neutral" });
      continue;
    }
    let first = true;
    for (const kind of WINDOW_DISPLAY_ORDER) {
      const window = provider.windows.find((w) => w.kind === kind);
      if (!window) {
        continue;
      }
      const remaining = window.remainingPercent ?? (window.usedPercent !== null ? Math.round((100 - window.usedPercent) * 10) / 10 : null);
      if (remaining === null) {
        continue;
      }
      segments.push({
        text: `${first ? `${provider.label} ` : ""}${Math.round(remaining)}%/${WINDOW_SHORT_LABELS[kind]}`,
        color: remainingColor(remaining),
      });
      first = false;
    }
  }
  return { segments };
}

export class QuotaService {
  private readonly authFilePath: string;
  private readonly quotaConfigPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly fsMod: typeof defaultFs;

  constructor(opts: QuotaServiceOptions = {}) {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    this.authFilePath = opts.authFilePath ?? path.join(dataHome, "opencode", "auth.json");
    this.quotaConfigPath = opts.quotaConfigPath ?? "";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fsMod = opts.fs ?? defaultFs;
  }

  async fetchAll(): Promise<QuotaSnapshot> {
    const entries = readAuthEntries(this.authFilePath, this.fsMod);
    const providers = await Promise.all([
      this.fetchKimi(bearerKey(entries["kimi-for-coding"])),
      this.fetchGlm(bearerKey(entries["zhipuai-coding-plan"])),
      this.fetchMimo(this.quotaConfigPath ? readMimoCookie(this.quotaConfigPath, this.fsMod) : null),
    ]);
    return { providers, fetchedAt: this.now().toISOString() };
  }

  async fetchKimi(apiKey: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("kimi", "Kimi");
    if (!apiKey) {
      return base;
    }
    try {
      const res = await this.fetchFn(KIMI_USAGE_URL, {
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return errorProvider({ ...base, configured: true }, `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      const usage = (data.usage ?? {}) as Record<string, unknown>;
      const windows: QuotaWindow[] = [];
      const seenKinds = new Set<QuotaWindowKind>();

      const weeklyLimit = toFiniteNumber(usage.limit);
      const weeklyRemaining = toFiniteNumber(usage.remaining);
      const weeklyUsed = toFiniteNumber(usage.used);
      if (weeklyLimit !== null) {
        seenKinds.add("weekly");
        windows.push({
          kind: "weekly",
          usedPercent: percent(weeklyUsed, weeklyLimit) ?? (weeklyRemaining !== null ? clampPercent(100 - percent(weeklyRemaining, weeklyLimit)!) : null),
          remainingPercent: percent(weeklyRemaining, weeklyLimit),
          used: weeklyUsed,
          limit: weeklyLimit,
          remaining: weeklyRemaining,
          resetAt: toIsoOrNull(usage.resetTime),
        });
      }

      const limits = Array.isArray(data.limits) ? (data.limits as Record<string, unknown>[]) : [];
      for (const item of limits) {
        const window = (item.window ?? {}) as Record<string, unknown>;
        const kind = kimiWindowKind(window.timeUnit, toFiniteNumber(window.duration));
        if (kind === null || seenKinds.has(kind)) {
          continue;
        }
        const detail = (item.detail ?? {}) as Record<string, unknown>;
        const limit = toFiniteNumber(detail.limit);
        const remaining = toFiniteNumber(detail.remaining);
        const used = toFiniteNumber(detail.used) ?? (limit !== null && remaining !== null ? limit - remaining : null);
        if (limit === null) {
          continue;
        }
        seenKinds.add(kind);
        windows.push({
          kind,
          usedPercent: percent(used, limit),
          remainingPercent: percent(remaining, limit),
          used,
          limit,
          remaining,
          resetAt: toIsoOrNull(detail.resetTime),
        });
      }

      // Kimi membership monthly quota (shares with web/app); present only on some plans.
      const totalQuota = (data.totalQuota ?? {}) as Record<string, unknown>;
      const monthlyLimit = toFiniteNumber(totalQuota.limit);
      if (monthlyLimit !== null && monthlyLimit > 0 && !seenKinds.has("monthly")) {
        const monthlyRemaining = toFiniteNumber(totalQuota.remaining);
        const monthlyUsed = toFiniteNumber(totalQuota.used) ?? (monthlyRemaining !== null ? monthlyLimit - monthlyRemaining : null);
        windows.push({
          kind: "monthly",
          usedPercent: percent(monthlyUsed, monthlyLimit),
          remainingPercent: percent(monthlyRemaining, monthlyLimit),
          used: monthlyUsed,
          limit: monthlyLimit,
          remaining: monthlyRemaining,
          resetAt: toIsoOrNull(totalQuota.resetTime),
        });
      }

      const level = ((data.user as Record<string, unknown> | undefined)?.membership as Record<string, unknown> | undefined)?.level;
      const plan = typeof level === "string" ? (KIMI_PLAN_LEVELS[level] ?? level.replace(/^LEVEL_/, "").toLowerCase()) : null;
      return { ...base, configured: true, plan, windows };
    } catch (error) {
      return errorProvider({ ...base, configured: true }, error instanceof Error ? error.message : String(error));
    }
  }

  async fetchGlm(apiKey: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("glm", "GLM");
    if (!apiKey) {
      return base;
    }
    try {
      const res = await this.fetchFn(GLM_QUOTA_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return errorProvider({ ...base, configured: true }, `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { code?: unknown; msg?: unknown; success?: unknown; data?: { limits?: unknown[]; level?: unknown } };
      if (payload.success === false || (typeof payload.code === "number" && payload.code !== 200)) {
        return errorProvider({ ...base, configured: true }, typeof payload.msg === "string" ? payload.msg : `code ${String(payload.code)}`);
      }
      const limits = Array.isArray(payload.data?.limits) ? (payload.data!.limits as Record<string, unknown>[]) : [];
      const windows: QuotaWindow[] = [];
      const seenKinds = new Set<QuotaWindowKind>();
      for (const limit of limits) {
        if (limit.type !== "TOKENS_LIMIT") {
          continue;
        }
        const usedPercent = toFiniteNumber(limit.percentage);
        const kind = glmWindowKind(toFiniteNumber(limit.unit), toFiniteNumber(limit.number));
        if (kind === null || usedPercent === null || seenKinds.has(kind)) {
          continue;
        }
        seenKinds.add(kind);
        windows.push({
          kind,
          usedPercent: clampPercent(usedPercent),
          remainingPercent: clampPercent(100 - usedPercent),
          used: null,
          limit: null,
          remaining: null,
          resetAt: toIsoOrNull(limit.nextResetTime),
        });
      }
      const plan = typeof payload.data?.level === "string" ? payload.data.level : null;
      return { ...base, configured: true, plan, windows };
    } catch (error) {
      return errorProvider({ ...base, configured: true }, error instanceof Error ? error.message : String(error));
    }
  }

  async fetchMimo(cookie: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("mimo", "MiMo");
    if (!cookie) {
      return base;
    }
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://platform.xiaomimimo.com",
      Referer: "https://platform.xiaomimimo.com/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    };
    const get = async (suffix: string): Promise<Record<string, unknown> | null> => {
      try {
        const res = await this.fetchFn(`${MIMO_API_BASE}${suffix}`, {
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          return null;
        }
        return (await res.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    try {
      const [balance, detail, usage] = await Promise.all([
        get("/balance"),
        get("/tokenPlan/detail"),
        get("/tokenPlan/usage"),
      ]);
      if (balance === null) {
        return errorProvider({ ...base, configured: true }, "额度接口请求失败（Cookie 可能已过期）");
      }
      const code = toFiniteNumber(balance.code);
      if (code !== 0) {
        return errorProvider({ ...base, configured: true }, `接口返回 code ${code}（Cookie 可能已过期）`);
      }
      const balanceData = (balance.data ?? {}) as Record<string, unknown>;
      const total = toFiniteNumber(balanceData.balance);
      const currency = typeof balanceData.currency === "string" ? balanceData.currency : null;
      const provider: ProviderQuota = {
        ...base,
        configured: true,
        balances: { total, currency },
      };

      const detailData = (detail?.data ?? {}) as Record<string, unknown>;
      const planCode = typeof detailData.planCode === "string" ? detailData.planCode : null;
      const periodEnd = typeof detailData.currentPeriodEnd === "string" ? detailData.currentPeriodEnd : null;

      const monthUsage = ((usage?.data as Record<string, unknown> | undefined)?.monthUsage ?? null) as Record<string, unknown> | null;
      const items = Array.isArray(monthUsage?.items) ? (monthUsage!.items as Record<string, unknown>[]) : [];
      const item = items[0] ?? {};
      const used = toFiniteNumber(item.used);
      const limit = toFiniteNumber(item.limit);
      const usedPercent = toFiniteNumber(item.percent) ?? percent(used, limit);
      const windows: QuotaWindow[] = [];
      if (usedPercent !== null) {
        windows.push({
          kind: "monthly",
          usedPercent: clampPercent(usedPercent),
          remainingPercent: clampPercent(100 - usedPercent),
          used,
          limit,
          remaining: used !== null && limit !== null ? limit - used : null,
          resetAt: toIsoOrNull(periodEnd),
        });
      }
      return { ...provider, plan: planCode, windows };
    } catch (error) {
      return errorProvider({ ...base, configured: true }, error instanceof Error ? error.message : String(error));
    }
  }
}
