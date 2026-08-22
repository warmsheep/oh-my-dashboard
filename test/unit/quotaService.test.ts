import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuotaService, formatQuotaBar } from "../../src/core/quotaService";

const sandboxes: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-"));
  sandboxes.push(dir);
  return dir;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const KIMI_PAYLOAD = {
  user: { membership: { level: "LEVEL_INTERMEDIATE" } },
  usage: { limit: "100", used: "28", remaining: "72", resetTime: "2026-08-23T10:08:21Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "90", resetTime: "2026-08-22T06:08:21Z" },
    },
  ],
};

const GLM_PAYLOAD = {
  code: 200,
  msg: "操作成功",
  success: true,
  data: {
    limits: [
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 3, currentValue: 0, remaining: 997, percentage: 0, nextResetTime: 1789628185998 },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 2, nextResetTime: 1787400622272 },
    ],
    level: "pro",
  },
};

const MIMO_BALANCE = { code: 0, data: { balance: "12.34", currency: "CNY", cashBalance: "10.00", giftBalance: "2.34" } };
const MIMO_DETAIL = { code: 0, data: { planCode: "lite", currentPeriodEnd: "2026-09-18 00:00:00", expired: false } };
const MIMO_USAGE = { code: 0, data: { monthUsage: { percent: 40, items: [{ name: "token", used: 40, limit: 100, percent: 40 }] } } };

describe("QuotaService.fetchAll — Kimi", () => {
  it("maps usage→weekly and limits[300min]→5h, requests with x-api-key", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "sk-kimi" } }));
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonRes(KIMI_PAYLOAD);
    };
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn });

    const snap = await svc.fetchAll();
    const kimi = snap.providers.find((p) => p.providerId === "kimi")!;

    expect(calls[0].url).toBe("https://api.kimi.com/coding/v1/usages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-kimi");
    expect(kimi.configured).toBe(true);
    expect(kimi.error).toBeNull();
    expect(kimi.plan).toBe("Allegretto");

    const weekly = kimi.windows.find((w) => w.kind === "weekly")!;
    expect(weekly.remainingPercent).toBe(72);
    expect(weekly.usedPercent).toBe(28);
    expect(weekly.resetAt).toBe("2026-08-23T10:08:21.000Z");

    const five = kimi.windows.find((w) => w.kind === "5h")!;
    expect(five.remainingPercent).toBe(90);
    expect(five.resetAt).toBe("2026-08-22T06:08:21.000Z");
  });

  it("accepts the 5h window declared as 5 TIME_UNIT_HOUR", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    const payload = { ...KIMI_PAYLOAD, limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "50", remaining: "10" } }] };
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async () => jsonRes(payload) });

    const snap = await svc.fetchAll();
    expect(snap.providers.find((p) => p.providerId === "kimi")!.windows.find((w) => w.kind === "5h")?.remainingPercent).toBe(20);
  });

  it("is not configured when auth.json has no kimi key (no request sent)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({}));
    let called = false;
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async () => { called = true; return jsonRes({}); } });

    const snap = await svc.fetchAll();
    const kimi = snap.providers.find((p) => p.providerId === "kimi")!;
    expect(kimi.configured).toBe(false);
    expect(called).toBe(false);
  });
});

describe("QuotaService.fetchAll — GLM", () => {
  it("maps TOKENS_LIMIT unit=3→5h (percentage is used%), ignores TIME_LIMIT, resets from epoch ms", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "glm-key" } }));
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonRes(GLM_PAYLOAD);
    };
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn });

    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;

    expect(calls[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(calls[0].headers["Authorization"]).toBe("Bearer glm-key");
    expect(glm.plan).toBe("pro");

    const five = glm.windows.find((w) => w.kind === "5h")!;
    expect(five.usedPercent).toBe(2);
    expect(five.remainingPercent).toBe(98);
    expect(five.resetAt).toBe(new Date(1787400622272).toISOString());
    expect(glm.windows.find((w) => w.kind === "monthly")).toBeUndefined();
  });

  it("also maps a weekly TOKENS_LIMIT (unit=6 weeks)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    const payload = { ...GLM_PAYLOAD, data: { ...GLM_PAYLOAD.data, limits: [
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: 1787400622272 },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: 1787400622272 },
    ] } };
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async () => jsonRes(payload) });

    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.windows.find((w) => w.kind === "weekly")?.usedPercent).toBe(9);
    expect(glm.windows.find((w) => w.kind === "5h")?.usedPercent).toBe(25);
  });

  it("surfaces API error envelopes", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async () => jsonRes({ code: 401, msg: "Unauthorized", success: false }) });

    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.error).toContain("Unauthorized");
    expect(glm.windows).toEqual([]);
  });
});

describe("QuotaService.fetchAll — MiMo", () => {
  function mimoEnv(cookie: string | undefined): { svc: QuotaService; urls: () => string[] } {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "xiaomi-token-plan-cn": { type: "api", key: "tp-xx" } }));
    if (cookie !== undefined) {
      fs.writeFileSync(path.join(dir, "quota.json"), JSON.stringify({ mimo: { cookie } }));
    }
    const urls: string[] = [];
    const fetchFn = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("/balance")) return jsonRes(MIMO_BALANCE);
      if (u.endsWith("/tokenPlan/detail")) return jsonRes(MIMO_DETAIL);
      if (u.endsWith("/tokenPlan/usage")) return jsonRes(MIMO_USAGE);
      return jsonRes({}, 404);
    };
    return { svc: new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn }), urls: () => urls };
  }

  it("queries the three dashboard endpoints with the cookie and maps monthUsage→monthly", async () => {
    const { svc, urls } = mimoEnv("api-platform_serviceToken=svc; userId=123");

    const snap = await svc.fetchAll();
    const mimo = snap.providers.find((p) => p.providerId === "mimo")!;

    expect(urls()).toContain("https://platform.xiaomimimo.com/api/v1/balance");
    expect(urls()).toContain("https://platform.xiaomimimo.com/api/v1/tokenPlan/detail");
    expect(urls()).toContain("https://platform.xiaomimimo.com/api/v1/tokenPlan/usage");
    expect(mimo.configured).toBe(true);
    expect(mimo.plan).toBe("lite");
    const monthly = mimo.windows.find((w) => w.kind === "monthly")!;
    expect(monthly.usedPercent).toBe(40);
    expect(monthly.remainingPercent).toBe(60);
    expect(monthly.used).toBe(40);
    expect(monthly.limit).toBe(100);
    expect(mimo.balances).toEqual({ total: 12.34, currency: "CNY" });
  });

  it("is not configured when quota.json carries no valid cookie", async () => {
    const { svc, urls } = mimoEnv("only_serviceToken=yes");

    const snap = await svc.fetchAll();
    const mimo = snap.providers.find((p) => p.providerId === "mimo")!;
    expect(mimo.configured).toBe(false);
    expect(urls()).toEqual([]);
  });
});

describe("QuotaService.fetchAll — DeepSeek", () => {
  const DEEPSEEK_BALANCE = {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    ],
  };

  function deepseekEnv(key: string | undefined): { svc: QuotaService; calls: () => { url: string; headers: Record<string, string> }[] } {
    const dir = tmpDir();
    const auth: Record<string, { type: string; key?: string }> = {};
    if (key !== undefined) {
      auth["deepseek"] = { type: "api", key };
    }
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(auth));
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonRes(DEEPSEEK_BALANCE);
    };
    return { svc: new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn }), calls: () => calls };
  }

  it("queries /user/balance with Bearer key and maps CNY balance, no windows (pay-as-you-go)", async () => {
    const { svc, calls } = deepseekEnv("sk-ds");

    const snap = await svc.fetchAll();
    const ds = snap.providers.find((p) => p.providerId === "deepseek")!;

    expect(calls()).toHaveLength(1);
    expect(calls()[0].url).toBe("https://api.deepseek.com/user/balance");
    expect(calls()[0].headers.Authorization).toBe("Bearer sk-ds");
    expect(ds.configured).toBe(true);
    expect(ds.error).toBeNull();
    expect(ds.balances).toEqual({ total: 110, currency: "CNY" });
    expect(ds.windows).toEqual([]);
  });

  it("prefers the CNY entry when the account holds multiple currencies", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "sk-ds" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () =>
        jsonRes({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "5.50", granted_balance: "0.00", topped_up_balance: "5.50" },
            { currency: "CNY", total_balance: "39.20", granted_balance: "0.00", topped_up_balance: "39.20" },
          ],
        }),
    });

    const snap = await svc.fetchAll();
    const ds = snap.providers.find((p) => p.providerId === "deepseek")!;
    expect(ds.balances).toEqual({ total: 39.2, currency: "CNY" });
  });

  it("falls back to the first currency entry when no CNY exists", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "sk-ds" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () =>
        jsonRes({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "5.50", granted_balance: "0.00", topped_up_balance: "5.50" },
          ],
        }),
    });

    const snap = await svc.fetchAll();
    const ds = snap.providers.find((p) => p.providerId === "deepseek")!;
    expect(ds.balances).toEqual({ total: 5.5, currency: "USD" });
  });

  it("reports unparseable balance payloads as an error, not a crash", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "sk-ds" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ is_available: true, balance_infos: [] }),
    });

    const snap = await svc.fetchAll();
    const ds = snap.providers.find((p) => p.providerId === "deepseek")!;
    expect(ds.configured).toBe(true);
    expect(ds.error).toContain("余额");
  });

  it("surfaces HTTP errors (401 invalid key)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "bad" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ message: "Authentication Fails" }, 401),
    });

    const snap = await svc.fetchAll();
    const ds = snap.providers.find((p) => p.providerId === "deepseek")!;
    expect(ds.configured).toBe(true);
    expect(ds.error).toBe("HTTP 401");
  });

  it("is not configured when auth.json has no deepseek key (no request sent)", async () => {
    const { svc, calls } = deepseekEnv(undefined);

    const snap = await svc.fetchAll();
    const ds = snap.providers.find((p) => p.providerId === "deepseek")!;
    expect(ds.configured).toBe(false);
    expect(calls()).toEqual([]);
  });
});

describe("formatQuotaBar — balance-only providers", () => {
  it("colors balance segments by absolute amount: >100 green", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T12:00:00.000Z",
      providers: [
        { providerId: "deepseek", label: "DeepSeek", plan: null, windows: [], balances: { total: 257.06, currency: "CNY" }, configured: true, error: null },
      ],
    });
    expect(bar.segments).toEqual([{ text: "DeepSeek ¥257.06", color: "green" }]);
  });

  it("colors balance segments: 20–100 yellow (boundaries inclusive)", () => {
    for (const total of [20, 42, 100]) {
      const bar = formatQuotaBar({
        fetchedAt: "2026-08-22T12:00:00.000Z",
        providers: [
          { providerId: "deepseek", label: "DeepSeek", plan: null, windows: [], balances: { total, currency: "CNY" }, configured: true, error: null },
        ],
      });
      expect(bar.segments).toEqual([{ text: `DeepSeek ¥${total}`, color: "yellow" }]);
    }
  });

  it("colors balance segments: <20 red, uses $ for USD and trims trailing zeros", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T12:00:00.000Z",
      providers: [
        { providerId: "deepseek", label: "DeepSeek", plan: null, windows: [], balances: { total: 5.5, currency: "USD" }, configured: true, error: null },
      ],
    });
    expect(bar.segments).toEqual([{ text: "DeepSeek $5.5", color: "red" }]);
  });

  it("skips providers with neither windows nor a parseable balance", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T12:00:00.000Z",
      providers: [
        { providerId: "deepseek", label: "DeepSeek", plan: null, windows: [], balances: null, configured: true, error: null },
      ],
    });
    expect(bar.segments).toEqual([]);
  });
});

describe("QuotaService.fetchAll — snapshot", () => {
  it("merges providers and stamps fetchedAt", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      "kimi-for-coding": { type: "api", key: "k" },
      "zhipuai-coding-plan": { type: "api", key: "g" },
    }));
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async (url: string | URL | Request) => jsonRes(String(url).includes("kimi.com") ? KIMI_PAYLOAD : GLM_PAYLOAD) });

    const snap = await svc.fetchAll();
    expect(snap.providers.map((p) => p.providerId)).toEqual(["kimi", "glm", "mimo", "deepseek"]);
    expect(snap.fetchedAt).toBeTruthy();
  });
});

describe("QuotaService — extra window kinds", () => {
  function kimiSvc(payload: unknown): QuotaService {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    return new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async () => jsonRes(payload) });
  }

  it("Kimi: maps limits[] 7-day and 30-day windows, and totalQuota→monthly; dedupes kinds", async () => {
    const svc = kimiSvc({
      usage: { limit: "100", used: "28", remaining: "72" },
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "100" } },
        { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "200", remaining: "50" } },
        { window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" }, detail: { limit: "900", remaining: "300" } },
        { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "999", remaining: "1" } },
      ],
      totalQuota: { limit: "1000", used: "400", remaining: "600", resetTime: "2026-09-01T00:00:00Z" },
    });
    const snap = await svc.fetchAll();
    const kimi = snap.providers.find((p) => p.providerId === "kimi")!;
    const kinds = kimi.windows.map((w) => w.kind);
    expect(kinds).toEqual(["weekly", "5h", "monthly"]);
    const limitsMonthly = kimi.windows.find((w) => w.kind === "monthly")!;
    expect(limitsMonthly.limit).toBe(900);
    expect(limitsMonthly.remainingPercent).toBe(33.3);
  });

  it("Kimi: totalQuota monthly only when it carries a positive limit", async () => {
    const svc = kimiSvc({ usage: { limit: "10", used: "1", remaining: "9" }, limits: [], totalQuota: {} });
    const snap = await svc.fetchAll();
    expect(snap.providers.find((p) => p.providerId === "kimi")!.windows.map((w) => w.kind)).toEqual(["weekly"]);
  });

  it("GLM: maps 30-day TOKENS_LIMIT to monthly", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    const svc = new QuotaService({ authFilePath: path.join(dir, "auth.json"), quotaConfigPath: path.join(dir, "quota.json"), fetchFn: async () => jsonRes({
      code: 200, success: true,
      data: { limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10, nextResetTime: 1787400622272 },
        { type: "TOKENS_LIMIT", unit: 1, number: 30, percentage: 40, nextResetTime: 1787400622272 },
      ], level: "max" },
    }) });
    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.windows.map((w) => w.kind)).toEqual(["5h", "monthly"]);
    expect(glm.windows.find((w) => w.kind === "monthly")!.remainingPercent).toBe(60);
  });
});

describe("formatQuotaBar", () => {
  it("renders one segment per window in 5h→7d→30d order, provider name only on the first segment", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T00:00:00.000Z",
      providers: [
        {
          providerId: "kimi", label: "Kimi", plan: null, configured: true, error: null, balances: null,
          windows: [
            { kind: "weekly", usedPercent: 28, remainingPercent: 72, used: null, limit: null, remaining: null, resetAt: null },
            { kind: "5h", usedPercent: 0, remainingPercent: 100, used: null, limit: null, remaining: null, resetAt: null },
            { kind: "monthly", usedPercent: 40, remainingPercent: 60, used: null, limit: null, remaining: null, resetAt: null },
          ],
        },
        {
          providerId: "glm", label: "GLM", plan: null, configured: true, error: null, balances: null,
          windows: [{ kind: "5h", usedPercent: 9, remainingPercent: 91, used: null, limit: null, remaining: null, resetAt: null }],
        },
      ],
    });
    expect(bar.segments).toEqual([
      { text: "Kimi 100%/5h", color: "green" },
      { text: "72%/7d", color: "green" },
      { text: "60%/30d", color: "green" },
      { text: "GLM 91%/5h", color: "green" },
    ]);
  });

  it("colors each window by its own remaining percent: ≥60 green, 20–60 yellow, <20 red", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T00:00:00.000Z",
      providers: [{
        providerId: "kimi", label: "Kimi", plan: null, configured: true, error: null, balances: null,
        windows: [
          { kind: "5h", usedPercent: 45, remainingPercent: 55, used: null, limit: null, remaining: null, resetAt: null },
          { kind: "weekly", usedPercent: 85, remainingPercent: 15, used: null, limit: null, remaining: null, resetAt: null },
          { kind: "monthly", usedPercent: 40, remainingPercent: 60, used: null, limit: null, remaining: null, resetAt: null },
        ],
      }],
    });
    expect(bar.segments.map((seg) => [seg.text, seg.color])).toEqual([
      ["Kimi 55%/5h", "yellow"],
      ["15%/7d", "red"],
      ["60%/30d", "green"],
    ]);
  });

  it("collapses errored providers to a neutral ? segment; empty snapshot yields no segments", () => {
    const errored = formatQuotaBar({
      fetchedAt: "2026-08-22T00:00:00.000Z",
      providers: [
        { providerId: "kimi", label: "Kimi", plan: null, configured: true, error: "HTTP 500", windows: [], balances: null },
        { providerId: "mimo", label: "MiMo", plan: null, configured: false, error: null, windows: [], balances: null },
      ],
    });
    expect(errored.segments).toEqual([{ text: "Kimi ?", color: "neutral" }]);
    expect(formatQuotaBar({ fetchedAt: "x", providers: [] }).segments).toEqual([]);
  });
});
