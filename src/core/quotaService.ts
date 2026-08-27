import * as defaultFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  balanceColor,
  deriveRemainingPercent,
  QUOTA_PROVIDER_IDS,
  QUOTA_WINDOW_ORDER,
  quotaCurrencySymbol,
  quotaProviderLabel,
  remainingColor,
} from "../shared/protocol";
import type {
  ProviderQuota,
  QuotaProviderId,
  QuotaSegmentColor,
  QuotaSnapshot,
  QuotaWindow,
  QuotaWindowKind,
} from "../shared/protocol";
import { writeFileAtomic } from "./atomicFile";

// Quota data shapes + shared display helpers live in shared/protocol.ts (single source,
// also consumed by the quota webview bundle); re-exported here so existing imports
// from core/quotaService keep working unchanged.
export type {
  ProviderQuota,
  QuotaProviderId,
  QuotaSegmentColor,
  QuotaSnapshot,
  QuotaWindow,
  QuotaWindowKind,
} from "../shared/protocol";
export { balanceColor, deriveRemainingPercent, remainingColor } from "../shared/protocol";

export interface QuotaServiceOptions {
  /** opencode credential store; defaults to $XDG_DATA_HOME/opencode/auth.json (~/.local/share/opencode/auth.json). */
  authFilePath?: string;
  /** Extension-owned quota config (<configDir>/quota.json) carrying the MiMo dashboard cookie. */
  quotaConfigPath?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  fs?: typeof import("node:fs");
  /** Max provider requests in flight at once (default 2, ≥1 enforced): bounds libuv threadpool occupation when DNS black-holes. */
  maxConcurrentRequests?: number;
}

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const MIMO_API_BASE = "https://platform.xiaomimimo.com/api/v1";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const KIMI_PLAN_LEVELS: Record<string, string> = {
  LEVEL_BASIC: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
  LEVEL_STANDARD: "Vivace",
};

/** GLM limit `unit` enum: 1=day 3=hour 5=minute 6=week (0=unknown), per open.bigmodel.cn's quota API. */
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

function glmWindowKind(unit: number | null, count: number | null): QuotaWindowKind | null {
  if (unit === GLM_UNIT_HOURS && count === 5) {
    return "5h";
  }
  if (unit === GLM_UNIT_WEEKS) {
    return "weekly";
  }
  if (unit === GLM_UNIT_DAYS && count === 7) {
    return "weekly";
  }
  if (unit === GLM_UNIT_DAYS && count !== null && count >= 28 && count <= 31) {
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
  if (part === null || whole === null || !Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return null;
  }
  return Math.round((part / whole) * 1000) / 10;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

// Engines since ES2015 serialize years outside 0-9999 as extended-year ISO ("+100205-…")
// instead of throwing RangeError; only NaN times still throw. Both paths must yield null:
// an out-of-range timestamp is garbage data and must not reach the status-bar tooltip.
function isoOrNull(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    const iso = date.toISOString();
    return iso.startsWith("+") || iso.startsWith("-") ? null : iso;
  } catch {
    return null;
  }
}

function toIsoOrNull(value: unknown): string | null {
  const num = toFiniteNumber(value);
  if (num !== null && num > 1_000_000_000) {
    const ms = num > 1e12 ? num : num * 1000;
    return isoOrNull(new Date(ms));
  }
  if (typeof value === "string") {
    return isoOrNull(new Date(value));
  }
  return null;
}

/** Shape of auth.json entries as they exist on disk; fields stay unknown until narrowed. */
interface AuthEntry {
  type?: unknown;
  key?: unknown;
}

function readAuthEntries(authFilePath: string, fsMod: typeof defaultFs): Record<string, AuthEntry> {
  try {
    const parsed: unknown = JSON.parse(fsMod.readFileSync(authFilePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, AuthEntry>) : {};
  } catch {
    return {};
  }
}

function bearerKey(entry: AuthEntry | undefined): string | null {
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

/**
 * Read a JSON response body defensively: undici's `res.json()` throws a raw
 * "Unexpected end of JSON input" SyntaxError on empty/truncated bodies (half-broken
 * connections, gateways answering 200 with no payload). Those must surface as
 * friendly, actionable messages instead of leaking into status-bar tooltips.
 * Shared by other core fetchers (model catalog) — single source of body handling.
 */
export async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === "") {
    throw new Error("接口返回了空响应");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("接口返回了无法解析的内容");
  }
}

/** Friendly message for timeout/abort-class transport failures (also the backoff marker). */
export const NETWORK_TIMEOUT_MESSAGE = "网络请求超时，请检查网络连接";
/** Friendly message for unreachable-network transport failures (also the backoff marker). */
export const NETWORK_UNAVAILABLE_MESSAGE = "网络不可用，请检查网络连接";

/**
 * Map transport-level failures (timeout/abort, DNS, refused/reset connections) to friendly
 * Chinese messages. AbortSignal.timeout aborts the fetch promise but cannot cancel a
 * getaddrinfo already parked on the libuv threadpool, so offline DNS hangs surface here.
 * API-level messages (HTTP codes, envelope errors, readJsonBody messages) pass through.
 * Shared by other core fetchers (model catalog) — single source of error mapping.
 */
export function friendlyRequestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`;
  if (error.name === "TimeoutError" || error.name === "AbortError" || /timeout/i.test(text)) {
    return NETWORK_TIMEOUT_MESSAGE;
  }
  if (
    /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|UND_ERR|terminated/i.test(
      text,
    )
  ) {
    return NETWORK_UNAVAILABLE_MESSAGE;
  }
  return error.message;
}

/** Backoff only helps when errors actually park threadpool threads (DNS/connect hangs). */
function isTransportError(message: string): boolean {
  return message === NETWORK_TIMEOUT_MESSAGE || message === NETWORK_UNAVAILABLE_MESSAGE;
}

/**
 * True when a refresh cycle should count as failed (for backoff): every configured
 * provider errored AND at least one is a transport-class error. Pure HTTP/API failures
 * return fast without occupying the libuv threadpool, so they keep the normal interval.
 * A null snapshot (fetchAll threw) always counts as failed.
 */
export function quotaCycleFailed(snapshot: QuotaSnapshot | null): boolean {
  if (!snapshot) {
    return true;
  }
  const configured = snapshot.providers.filter((provider) => provider.configured);
  return (
    configured.length > 0 &&
    configured.every((provider) => provider.error !== null) &&
    configured.some((provider) => isTransportError(provider.error!))
  );
}

/** Failure backoff cap for auto-refresh: never wait longer than 2 minutes before retrying. */
const QUOTA_RETRY_CAP_MS = 120_000;

/**
 * Auto-refresh delay after `streak` consecutive failed cycles: doubles per failure,
 * capped at 120s, never below the configured base (a bigger configured interval is
 * never shortened by backoff). `baseSeconds` of 0 keeps auto-refresh disabled.
 */
export function quotaRetryDelayMs(baseSeconds: number, streak: number): number {
  if (!(baseSeconds > 0)) {
    return 0;
  }
  const base = baseSeconds * 1_000;
  return Math.round(Math.max(base, Math.min(base * 2 ** streak, QUOTA_RETRY_CAP_MS)));
}

const WINDOW_SHORT_LABELS: Record<QuotaWindowKind, string> = { "5h": "5h", weekly: "7d", monthly: "30d" };

export interface QuotaBarSegment {
  text: string;
  color: QuotaSegmentColor;
}

export interface QuotaBar {
  segments: QuotaBarSegment[];
}

function balanceSegmentText(label: string, total: number, currency: string): string {
  const symbol = quotaCurrencySymbol(currency);
  const trimmed = Math.round(total * 100) / 100;
  return `${label} ${symbol}${trimmed}`;
}

/**
 * Pure status-bar builder: one segment per (provider, window) so each window gets its own
 * color — "Kimi 100%/5h", "72%/7d", "GLM 91%/5h" in 5h → 7d → 30d order (remaining percent,
 * provider name only on its first segment). Errored providers collapse to a neutral "?" segment;
 * windowless providers with a balance render a neutral "DeepSeek ¥110" currency segment.
 */
export function formatQuotaBar(snapshot: QuotaSnapshot): QuotaBar {
  const segments: QuotaBarSegment[] = [];
  for (const provider of snapshot.providers) {
    if (provider.error !== null) {
      segments.push({ text: `${provider.label} ?`, color: "neutral" });
      continue;
    }
    let first = true;
    for (const kind of QUOTA_WINDOW_ORDER) {
      const window = provider.windows.find((w) => w.kind === kind);
      if (!window) {
        continue;
      }
      const remaining = deriveRemainingPercent(window);
      if (remaining === null) {
        continue;
      }
      segments.push({
        text: `${first ? `${provider.label} ` : ""}${Math.round(remaining)}%/${WINDOW_SHORT_LABELS[kind]}`,
        color: remainingColor(remaining),
      });
      first = false;
    }
    if (first && provider.balances?.total != null && provider.balances.currency) {
      segments.push({
        text: balanceSegmentText(provider.label, provider.balances.total, provider.balances.currency),
        color: balanceColor(provider.balances.total),
      });
    }
  }
  return { segments };
}

/**
 * Pure merge for single-provider refreshes: replace the matching provider in place
 * (canonical order preserved); a provider missing from the snapshot is inserted at
 * its QUOTA_PROVIDER_IDS position. `fetchedAt` is caller-supplied so the function
 * stays pure/testable.
 */
export function mergeProviderSnapshot(
  snapshot: QuotaSnapshot,
  provider: ProviderQuota,
  fetchedAt: string,
): QuotaSnapshot {
  const index = snapshot.providers.findIndex((existing) => existing.providerId === provider.providerId);
  if (index >= 0) {
    const providers = [...snapshot.providers];
    providers[index] = provider;
    return { providers, fetchedAt };
  }
  const providers = [...snapshot.providers];
  const insertAt = QUOTA_PROVIDER_IDS.indexOf(provider.providerId);
  if (insertAt < 0 || insertAt >= providers.length) {
    providers.push(provider);
  } else {
    providers.splice(insertAt, 0, provider);
  }
  return { providers, fetchedAt };
}

/**
 * Circuit breaker: consecutive transport-failed cycles after which auto-refresh stops
 * scheduling itself entirely (a manual refresh or settings change re-arms it). DNS
 * black-holes park getaddrinfo on the SHARED libuv threadpool for every extension in
 * the host — bounded backoff alone still keeps poking the pool forever.
 */
export const QUOTA_PAUSE_AFTER_STREAK = 3;

/** True once `streak` consecutive transport-failed cycles reached the breaker threshold. */
export function quotaShouldPauseAutoRefresh(streak: number): boolean {
  return streak >= QUOTA_PAUSE_AFTER_STREAK;
}

/**
 * Minimal async semaphore bounding in-flight provider requests. AbortSignal.timeout
 * abandons the fetch PROMISE but cannot cancel a getaddrinfo already parked on the
 * libuv threadpool (default 4 threads, shared by every extension's async fs), so the
 * only real protection is never issuing more concurrent requests than the cap.
 */
class RequestGate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class QuotaService {
  private readonly authFilePath: string;
  private readonly quotaConfigPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly fsMod: typeof defaultFs;
  private readonly gate: RequestGate;

  constructor(opts: QuotaServiceOptions = {}) {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    this.authFilePath = opts.authFilePath ?? path.join(dataHome, "opencode", "auth.json");
    this.quotaConfigPath = opts.quotaConfigPath ?? "";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fsMod = opts.fs ?? defaultFs;
    // Cap of 2 keeps at most 2 threadpool threads parked per cycle even when DNS
    // black-holes; a single MiMo cycle (3 sequential requests) still holds 1 slot.
    this.gate = new RequestGate(Math.max(1, opts.maxConcurrentRequests ?? 2));
  }

  async fetchAll(): Promise<QuotaSnapshot> {
    // One auth.json read shared by all four providers (fetchProvider re-reads for solo runs).
    // Every provider fetch goes through the gate: at most `maxConcurrentRequests`
    // requests exist at once, however many callers (timer cycle, panel buttons) fire.
    const entries = readAuthEntries(this.authFilePath, this.fsMod);
    const providers = await Promise.all(
      QUOTA_PROVIDER_IDS.map((id) => this.gate.run(() => this.fetchProviderWith(id, entries))),
    );
    return { providers, fetchedAt: this.now().toISOString() };
  }

  /** Refresh ONE provider (quota panel per-group refresh): reads its credential fresh and fetches only its endpoint. */
  async fetchProvider(providerId: QuotaProviderId): Promise<ProviderQuota> {
    const entries = readAuthEntries(this.authFilePath, this.fsMod);
    return this.gate.run(() => this.fetchProviderWith(providerId, entries));
  }

  private fetchProviderWith(providerId: QuotaProviderId, entries: Record<string, AuthEntry>): Promise<ProviderQuota> {
    switch (providerId) {
      case "kimi":
        return this.fetchKimi(bearerKey(entries["kimi-for-coding"]));
      case "glm":
        return this.fetchGlm(bearerKey(entries["zhipuai-coding-plan"]));
      case "mimo":
        return this.fetchMimo(this.quotaConfigPath ? readMimoCookie(this.quotaConfigPath, this.fsMod) : null);
      case "deepseek":
        return this.fetchDeepSeek(bearerKey(entries["deepseek"]));
    }
  }

  /**
   * DeepSeek is pay-as-you-go: the only programmatic source is GET /user/balance
   * (no quota windows / usage endpoints exist). balance_infos carries one entry per
   * currency; CNY wins when present, otherwise the first entry.
   */
  async fetchDeepSeek(apiKey: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("deepseek", quotaProviderLabel("deepseek"));
    if (!apiKey) {
      return base;
    }
    try {
      const res = await this.fetchFn(DEEPSEEK_BALANCE_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return errorProvider({ ...base, configured: true }, `接口返回 HTTP ${res.status}`);
      }
      const data = (await readJsonBody(res)) as { is_available?: unknown; balance_infos?: unknown };
      const infos = Array.isArray(data.balance_infos) ? (data.balance_infos as Record<string, unknown>[]) : [];
      const pick = infos.find((info) => info.currency === "CNY") ?? infos[0];
      const total = toFiniteNumber(pick?.total_balance);
      const currency = typeof pick?.currency === "string" ? pick.currency : null;
      if (total === null || currency === null) {
        return errorProvider({ ...base, configured: true }, "接口未返回可解析的余额数据");
      }
      return { ...base, configured: true, balances: { total, currency } };
    } catch (error) {
      return errorProvider({ ...base, configured: true }, friendlyRequestError(error));
    }
  }

  async fetchKimi(apiKey: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("kimi", quotaProviderLabel("kimi"));
    if (!apiKey) {
      return base;
    }
    try {
      const res = await this.fetchFn(KIMI_USAGE_URL, {
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return errorProvider({ ...base, configured: true }, `接口返回 HTTP ${res.status}`);
      }
      const data = (await readJsonBody(res)) as Record<string, unknown>;
      const usage = (data.usage ?? {}) as Record<string, unknown>;
      const windows: QuotaWindow[] = [];
      const seenKinds = new Set<QuotaWindowKind>();

      const weeklyLimit = toFiniteNumber(usage.limit);
      const weeklyRemaining = toFiniteNumber(usage.remaining);
      const weeklyUsed = toFiniteNumber(usage.used);
      if (weeklyLimit !== null) {
        // percent() returns null for whole<=0 — deriving from it must stay null then,
        // never 100 - null (which coerces to a fabricated 100%).
        const derived = percent(weeklyRemaining, weeklyLimit);
        seenKinds.add("weekly");
        windows.push({
          kind: "weekly",
          usedPercent:
            percent(weeklyUsed, weeklyLimit) ??
            (weeklyRemaining !== null && derived !== null ? clampPercent(100 - derived) : null),
          remainingPercent: derived,
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
        const monthlyUsed =
          toFiniteNumber(totalQuota.used) ?? (monthlyRemaining !== null ? monthlyLimit - monthlyRemaining : null);
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

      const level = (
        (data.user as Record<string, unknown> | undefined)?.membership as Record<string, unknown> | undefined
      )?.level;
      const plan =
        typeof level === "string" ? (KIMI_PLAN_LEVELS[level] ?? level.replace(/^LEVEL_/, "").toLowerCase()) : null;
      return { ...base, configured: true, plan, windows };
    } catch (error) {
      return errorProvider({ ...base, configured: true }, friendlyRequestError(error));
    }
  }

  async fetchGlm(apiKey: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("glm", quotaProviderLabel("glm"));
    if (!apiKey) {
      return base;
    }
    try {
      const res = await this.fetchFn(GLM_QUOTA_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return errorProvider({ ...base, configured: true }, `接口返回 HTTP ${res.status}`);
      }
      const payload = (await readJsonBody(res)) as {
        code?: unknown;
        msg?: unknown;
        success?: unknown;
        data?: { limits?: unknown[]; level?: unknown };
      };
      if (payload.success === false || (typeof payload.code === "number" && payload.code !== 200)) {
        const detail =
          typeof payload.msg === "string"
            ? payload.msg.length > 120
              ? `${payload.msg.slice(0, 120)}…`
              : payload.msg
            : `code ${String(payload.code)}`;
        return errorProvider({ ...base, configured: true }, `接口错误：${detail}`);
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
      return errorProvider({ ...base, configured: true }, friendlyRequestError(error));
    }
  }

  async fetchMimo(cookie: string | null): Promise<ProviderQuota> {
    const base = emptyProvider("mimo", quotaProviderLabel("mimo"));
    if (!cookie) {
      return base;
    }
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://platform.xiaomimimo.com",
      Referer: "https://platform.xiaomimimo.com/",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    };
    const get = async (suffix: string): Promise<Record<string, unknown>> => {
      const res = await this.fetchFn(`${MIMO_API_BASE}${suffix}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const cookieHint = res.status === 401 || res.status === 403 ? "（Cookie 可能已过期）" : "";
        throw new Error(`接口返回 HTTP ${res.status}${cookieHint}`);
      }
      return (await readJsonBody(res)) as Record<string, unknown>;
    };
    try {
      // Sequential on purpose: each pending DNS lookup parks a libuv threadpool thread that
      // AbortSignal cannot cancel, so MiMo must never hold more than one in-flight request.
      const balance = await get("/balance");
      const detail = await get("/tokenPlan/detail").catch(() => null);
      const usage = await get("/tokenPlan/usage").catch(() => null);
      // A missing `code` field means success (gateways may strip the envelope); only an
      // explicit non-zero code is a business failure.
      const code = toFiniteNumber(balance.code);
      if (code !== null && code !== 0) {
        const cookieHint = code === 401 || code === 403 ? "（Cookie 可能已过期）" : "";
        return errorProvider({ ...base, configured: true }, `接口返回 code ${code}${cookieHint}`);
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

      const monthUsage = ((usage?.data as Record<string, unknown> | undefined)?.monthUsage ?? null) as Record<
        string,
        unknown
      > | null;
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
      return errorProvider({ ...base, configured: true }, friendlyRequestError(error));
    }
  }

  /**
   * Persist the MiMo dashboard cookie into the configured quota.json (<configDir>/quota.json):
   * normalize (invalid → throws `MIMO_COOKIE_INVALID`), merge into the existing document
   * (corrupt content heals to a fresh object; unreadable-but-existing file aborts with
   * `CONFIG_UNREADABLE`), mkdir the parent dir on demand, atomic write, then best-effort
   * chmod 0600 (credential; no-op where unsupported). Requires quotaConfigPath to be set.
   */
  saveMimoCookie(cookie: string): void {
    const normalized = normalizeMimoCookie(cookie);
    if (normalized === null) {
      throw new Error("MIMO_COOKIE_INVALID");
    }
    let root: Record<string, unknown> = {};
    const existing = this.readQuotaConfigTextForEdit();
    if (existing !== "") {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          root = parsed as Record<string, unknown>;
        }
      } catch {
        // Extension-owned file: corrupt content is healed, not preserved.
      }
    }
    const mimo =
      root.mimo && typeof root.mimo === "object" && !Array.isArray(root.mimo)
        ? { ...(root.mimo as Record<string, unknown>) }
        : {};
    root.mimo = { ...mimo, cookie: normalized };
    this.fsMod.mkdirSync(path.dirname(this.quotaConfigPath), { recursive: true });
    writeFileAtomic(this.quotaConfigPath, `${JSON.stringify(root, null, 2)}\n`, this.fsMod);
    try {
      this.fsMod.chmodSync(this.quotaConfigPath, 0o600);
    } catch {
      // Owner-only permission is best-effort; platforms without POSIX modes ignore it.
    }
  }

  /** readTextForEdit contract: "" only when genuinely absent; unreadable → CONFIG_UNREADABLE. */
  private readQuotaConfigTextForEdit(): string {
    try {
      return this.fsMod.existsSync(this.quotaConfigPath) ? this.fsMod.readFileSync(this.quotaConfigPath, "utf8") : "";
    } catch {
      throw new Error("CONFIG_UNREADABLE");
    }
  }
}
