import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveRemainingPercent,
  formatQuotaBar,
  mergeProviderSnapshot,
  NETWORK_TIMEOUT_MESSAGE,
  NETWORK_UNAVAILABLE_MESSAGE,
  normalizeMimoCookie,
  normalizeQuotaVisibility,
  providerHasDisplayData,
  QUOTA_PAUSE_AFTER_STREAK,
  quotaCycleFailed,
  quotaRetryDelayMs,
  QuotaService,
  quotaShouldPauseAutoRefresh,
  quotaSnapshotDegraded,
  readQuotaStatusBarVisibility,
  spliceStaleProviders,
  STALE_PROVIDER_MAX_AGE_MS,
  type ProviderQuota,
  type QuotaProviderId,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../../src/core/quotaService";

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
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 3,
        currentValue: 0,
        remaining: 997,
        percentage: 0,
        nextResetTime: 1789628185998,
      },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 2, nextResetTime: 1787400622272 },
    ],
    level: "pro",
  },
};

const MIMO_BALANCE = {
  code: 0,
  data: { balance: "12.34", currency: "CNY", cashBalance: "10.00", giftBalance: "2.34" },
};
const MIMO_DETAIL = { code: 0, data: { planCode: "lite", currentPeriodEnd: "2026-09-18 00:00:00", expired: false } };
const MIMO_USAGE = {
  code: 0,
  data: { monthUsage: { percent: 40, items: [{ name: "token", used: 40, limit: 100, percent: 40 }] } },
};

describe("QuotaService.fetchAll — Kimi", () => {
  it("maps usage→weekly and limits[300min]→5h, requests with x-api-key", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ "kimi-for-coding": { type: "api", key: "sk-kimi" } }),
    );
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonRes(KIMI_PAYLOAD);
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn,
    });

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
    const payload = {
      ...KIMI_PAYLOAD,
      limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "50", remaining: "10" } }],
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes(payload),
    });

    const snap = await svc.fetchAll();
    expect(
      snap.providers.find((p) => p.providerId === "kimi")!.windows.find((w) => w.kind === "5h")?.remainingPercent,
    ).toBe(20);
  });

  it("is not configured when auth.json has no kimi key (no request sent)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({}));
    let called = false;
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => {
        called = true;
        return jsonRes({});
      },
    });

    const snap = await svc.fetchAll();
    const kimi = snap.providers.find((p) => p.providerId === "kimi")!;
    expect(kimi.configured).toBe(false);
    expect(called).toBe(false);
  });

  it("keeps usedPercent null when limit<=0 instead of fabricating 100% via 100-null", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ usage: { limit: 0, used: null, remaining: 25 }, limits: [] }),
    });

    const snap = await svc.fetchAll();
    const kimi = snap.providers.find((p) => p.providerId === "kimi")!;
    expect(kimi.error).toBeNull();
    const weekly = kimi.windows.find((w) => w.kind === "weekly")!;
    expect(weekly.usedPercent).toBeNull();
    expect(weekly.remainingPercent).toBeNull();
  });

  it("maps epoch reset times beyond year 9999 to null resetAt, not a RangeError error state", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    // ~3.1e15 ms ≈ year 100000: getTime() is finite but toISOString() throws RangeError.
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () =>
        jsonRes({ usage: { limit: "100", used: "1", remaining: "99", resetTime: 3.1e15 }, limits: [] }),
    });

    const snap = await svc.fetchAll();
    const kimi = snap.providers.find((p) => p.providerId === "kimi")!;
    expect(kimi.error).toBeNull();
    expect(kimi.windows.find((w) => w.kind === "weekly")!.resetAt).toBeNull();
  });

  it("multiplies epoch-SECOND reset times (1e9–1e12) by 1000 before mapping to ISO", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () =>
        jsonRes({ usage: { limit: "100", used: "1", remaining: "99", resetTime: 1_789_628_185 }, limits: [] }),
    });

    const snap = await svc.fetchAll();
    expect(snap.providers.find((p) => p.providerId === "kimi")!.windows.find((w) => w.kind === "weekly")!.resetAt).toBe(
      "2026-09-17T06:56:25.000Z",
    );
  });

  it("derives weekly usedPercent from remaining when `used` is absent, clamping into 0–100", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ usage: { limit: "100", remaining: "25" }, limits: [] }),
    });

    const snap = await svc.fetchAll();
    const weekly = snap.providers.find((p) => p.providerId === "kimi")!.windows.find((w) => w.kind === "weekly")!;
    expect(weekly.usedPercent).toBe(75);
    expect(weekly.remainingPercent).toBe(25);

    const overflow = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ usage: { limit: "100", remaining: "105" }, limits: [] }),
    });
    const clamped = (await overflow.fetchAll()).providers
      .find((p) => p.providerId === "kimi")!
      .windows.find((w) => w.kind === "weekly")!;
    expect(clamped.usedPercent).toBe(0); // 100 − 105% clamped at the floor
    expect(clamped.remainingPercent).toBe(105); // only the derived used side is clamped
  });

  it("reports HTTP status with a Chinese frame", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "bad" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({}, 401),
    });

    const snap = await svc.fetchAll();
    expect(snap.providers.find((p) => p.providerId === "kimi")!.error).toBe("接口返回 HTTP 401");
  });
});

describe("QuotaService.fetchAll — GLM", () => {
  it("maps TOKENS_LIMIT unit=3→5h (percentage is used%), ignores TIME_LIMIT, resets from epoch ms", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "glm-key" } }),
    );
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return jsonRes(GLM_PAYLOAD);
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn,
    });

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
    const payload = {
      ...GLM_PAYLOAD,
      data: {
        ...GLM_PAYLOAD.data,
        limits: [
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: 1787400622272 },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: 1787400622272 },
        ],
      },
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes(payload),
    });

    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.windows.find((w) => w.kind === "weekly")?.usedPercent).toBe(9);
    expect(glm.windows.find((w) => w.kind === "5h")?.usedPercent).toBe(25);
  });

  it("surfaces API error envelopes", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ code: 401, msg: "Unauthorized", success: false }),
    });

    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.error).toBe("接口错误：Unauthorized");
    expect(glm.windows).toEqual([]);
  });

  it("prefixes and truncates long GLM msg passthroughs", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    const longMsg = "x".repeat(300);
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes({ code: 500, msg: longMsg, success: false }),
    });

    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.error).toMatch(/^接口错误：/);
    expect(glm.error!.length).toBeLessThanOrEqual("接口错误：".length + 121);
    expect(glm.error).toContain("x".repeat(100));
  });

  it("reports HTTP status with a Chinese frame", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => new Response("nope", { status: 500 }),
    });

    const snap = await svc.fetchAll();
    expect(snap.providers.find((p) => p.providerId === "glm")!.error).toBe("接口返回 HTTP 500");
  });
});

describe("QuotaService.fetchAll — MiMo", () => {
  function mimoEnv(cookie: string | undefined): { svc: QuotaService; urls: () => string[] } {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ "xiaomi-token-plan-cn": { type: "api", key: "tp-xx" } }),
    );
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
    return {
      svc: new QuotaService({
        authFilePath: path.join(dir, "auth.json"),
        quotaConfigPath: path.join(dir, "quota.json"),
        fetchFn,
      }),
      urls: () => urls,
    };
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

  it("treats a missing envelope code as success (only explicit non-zero codes error)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
    );
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith("/balance")) return jsonRes({ data: { balance: "12.34", currency: "CNY" } });
        if (u.endsWith("/tokenPlan/detail")) return jsonRes(MIMO_DETAIL);
        return jsonRes(MIMO_USAGE);
      },
    });

    const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
    expect(mimo.error).toBeNull();
    expect(mimo.balances).toEqual({ total: 12.34, currency: "CNY" });
  });

  it("degrades gracefully when detail/usage endpoints fail but balance succeeds (plan null, no error)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
    );
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith("/balance")) return jsonRes(MIMO_BALANCE);
        return jsonRes({}, 500); // detail AND usage both failing
      },
    });

    const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
    expect(mimo.error).toBeNull();
    expect(mimo.configured).toBe(true);
    expect(mimo.plan).toBeNull();
    expect(mimo.windows).toEqual([]);
    expect(mimo.balances).toEqual({ total: 12.34, currency: "CNY" });
  });
});

describe("QuotaService.fetchAll — DeepSeek", () => {
  const DEEPSEEK_BALANCE = {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    ],
  };

  function deepseekEnv(key: string | undefined): {
    svc: QuotaService;
    calls: () => { url: string; headers: Record<string, string> }[];
  } {
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
    return {
      svc: new QuotaService({
        authFilePath: path.join(dir, "auth.json"),
        quotaConfigPath: path.join(dir, "quota.json"),
        fetchFn,
      }),
      calls: () => calls,
    };
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
    expect(ds.error).toBe("接口返回 HTTP 401");
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
        {
          providerId: "deepseek",
          label: "DeepSeek",
          plan: null,
          windows: [],
          balances: { total: 257.06, currency: "CNY" },
          configured: true,
          error: null,
        },
      ],
    });
    expect(bar.segments).toEqual([{ text: "DeepSeek ¥257.06", color: "green" }]);
  });

  it("colors balance segments: 20–100 yellow (boundaries inclusive)", () => {
    for (const total of [20, 42, 100]) {
      const bar = formatQuotaBar({
        fetchedAt: "2026-08-22T12:00:00.000Z",
        providers: [
          {
            providerId: "deepseek",
            label: "DeepSeek",
            plan: null,
            windows: [],
            balances: { total, currency: "CNY" },
            configured: true,
            error: null,
          },
        ],
      });
      expect(bar.segments).toEqual([{ text: `DeepSeek ¥${total}`, color: "yellow" }]);
    }
  });

  it("colors balance segments: <20 red, uses $ for USD and trims trailing zeros", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T12:00:00.000Z",
      providers: [
        {
          providerId: "deepseek",
          label: "DeepSeek",
          plan: null,
          windows: [],
          balances: { total: 5.5, currency: "USD" },
          configured: true,
          error: null,
        },
      ],
    });
    expect(bar.segments).toEqual([{ text: "DeepSeek $5.5", color: "red" }]);
  });

  it("skips providers with neither windows nor a parseable balance", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T12:00:00.000Z",
      providers: [
        {
          providerId: "deepseek",
          label: "DeepSeek",
          plan: null,
          windows: [],
          balances: null,
          configured: true,
          error: null,
        },
      ],
    });
    expect(bar.segments).toEqual([]);
  });
});

describe("QuotaService.fetchAll — snapshot", () => {
  it("merges providers and stamps fetchedAt from the injected clock", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "kimi-for-coding": { type: "api", key: "k" },
        "zhipuai-coding-plan": { type: "api", key: "g" },
      }),
    );
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      now: () => new Date("2026-08-22T12:00:00.000Z"),
      fetchFn: async (url: string | URL | Request) =>
        jsonRes(String(url).includes("kimi.com") ? KIMI_PAYLOAD : GLM_PAYLOAD),
    });

    const snap = await svc.fetchAll();
    expect(snap.providers.map((p) => p.providerId)).toEqual(["kimi", "glm", "mimo", "deepseek"]);
    expect(snap.fetchedAt).toBe("2026-08-22T12:00:00.000Z");
  });
});

describe("QuotaService.fetchAll — auth.json 容错", () => {
  it("auth.json 缺失或损坏时四个 provider 全部未配置，且零网络请求", async () => {
    for (const seed of [undefined, "{ not valid json"]) {
      const dir = tmpDir();
      if (seed !== undefined) {
        fs.writeFileSync(path.join(dir, "auth.json"), seed);
      }
      let calls = 0;
      const svc = new QuotaService({
        authFilePath: path.join(dir, "auth.json"),
        quotaConfigPath: path.join(dir, "quota.json"),
        fetchFn: async () => {
          calls += 1;
          return jsonRes({});
        },
      });

      const snap = await svc.fetchAll();
      expect(snap.providers.map((p) => p.configured)).toEqual([false, false, false, false]);
      expect(snap.providers.every((p) => p.error === null)).toBe(true);
      expect(calls).toBe(0);
    }
  });
});

describe("normalizeMimoCookie", () => {
  it("剥 'Cookie:' 前缀、白名单外键丢弃、保留合法键的顺序与原值", () => {
    expect(
      normalizeMimoCookie(
        "Cookie: api-platform_serviceToken=abc; junk=1; userId=42; api-platform_ph=p; api-platform_slh=s",
      ),
    ).toBe("api-platform_serviceToken=abc; userId=42; api-platform_ph=p; api-platform_slh=s");
    expect(normalizeMimoCookie("api-platform_serviceToken=abc;; userId=42")).toBe(
      "api-platform_serviceToken=abc; userId=42",
    );
  });

  it("缺 serviceToken 或 userId 任一必需 cookie 时返回 null", () => {
    expect(normalizeMimoCookie("api-platform_serviceToken=abc")).toBeNull();
    expect(normalizeMimoCookie("userId=42")).toBeNull();
    expect(normalizeMimoCookie("")).toBeNull();
    expect(normalizeMimoCookie(42)).toBeNull();
  });
});

describe("QuotaService — extra window kinds", () => {
  function kimiSvc(payload: unknown): QuotaService {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    return new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => jsonRes(payload),
    });
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
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () =>
        jsonRes({
          code: 200,
          success: true,
          data: {
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10, nextResetTime: 1787400622272 },
              { type: "TOKENS_LIMIT", unit: 1, number: 30, percentage: 40, nextResetTime: 1787400622272 },
            ],
            level: "max",
          },
        }),
    });
    const snap = await svc.fetchAll();
    const glm = snap.providers.find((p) => p.providerId === "glm")!;
    expect(glm.windows.map((w) => w.kind)).toEqual(["5h", "monthly"]);
    expect(glm.windows.find((w) => w.kind === "monthly")!.remainingPercent).toBe(60);
  });
});

describe("QuotaService — 离线韧性与错误映射", () => {
  function glmSvc(fetchImpl: () => Promise<Response>): QuotaService {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "zhipuai-coding-plan": { type: "api", key: "k" } }));
    return new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: fetchImpl,
    });
  }

  function glmOf(snap: QuotaSnapshot) {
    return snap.providers.find((p) => p.providerId === "glm")!;
  }

  it("空 200 响应映射为友好错误，而非泄漏 'Unexpected end of JSON input'", async () => {
    const svc = glmSvc(async () => new Response("", { status: 200 }));
    const glm = glmOf(await svc.fetchAll());
    expect(glm.error).toContain("空响应");
    expect(glm.error).not.toContain("Unexpected end of JSON input");
  });

  it("非 JSON 响应体映射为友好解析错误", async () => {
    const svc = glmSvc(async () => new Response("<html>gateway error</html>", { status: 200 }));
    const glm = glmOf(await svc.fetchAll());
    expect(glm.error).toContain("解析");
    expect(glm.error).not.toContain("<html>");
  });

  it("底层网络失败（fetch failed + ENOTFOUND cause）映射为友好网络错误", async () => {
    const svc = glmSvc(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND open.bigmodel.cn") });
    });
    const glm = glmOf(await svc.fetchAll());
    expect(glm.error).toBe(NETWORK_UNAVAILABLE_MESSAGE);
    expect(glm.error).not.toContain("fetch failed");
  });

  it("中断/超时类错误映射为友好超时提示", async () => {
    const svc = glmSvc(async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    });
    const glm = glmOf(await svc.fetchAll());
    expect(glm.error).toBe(NETWORK_TIMEOUT_MESSAGE);
  });

  it("AbortSignal.timeout 实际产出的 TimeoutError 名字也映射为超时", async () => {
    const svc = glmSvc(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const glm = glmOf(await svc.fetchAll());
    expect(glm.error).toBe(NETWORK_TIMEOUT_MESSAGE);
  });

  it("undici 截断响应体的 Terminated TypeError 映射为网络错误", async () => {
    const svc = glmSvc(async () => {
      throw new TypeError("Terminated");
    });
    const glm = glmOf(await svc.fetchAll());
    expect(glm.error).toBe(NETWORK_UNAVAILABLE_MESSAGE);
  });

  it("MiMo 网络故障不再误报为 Cookie 过期", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
    );
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => {
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 1.2.3.4:443") });
      },
    });
    const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
    expect(mimo.error).toBe(NETWORK_UNAVAILABLE_MESSAGE);
    expect(mimo.error).not.toContain("Cookie");
  });

  it("MiMo balance 返回 401 才提示 Cookie 过期", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
    );
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => new Response("{}", { status: 401 }),
    });
    const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
    expect(mimo.error).toContain("接口返回 HTTP 401");
    expect(mimo.error).toContain("Cookie");
  });

  it("MiMo 网关 502 报 HTTP 状态而非 Cookie 过期", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
    );
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async () => new Response("bad gateway", { status: 502 }),
    });
    const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
    expect(mimo.error).toBe("接口返回 HTTP 502");
    expect(mimo.error).not.toContain("Cookie");
  });

  it("MiMo envelope code 401 附 Cookie 提示，非鉴权码不附", async () => {
    for (const [code, expectHint] of [
      [401, true],
      [500, false],
    ] as const) {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "auth.json"), "{}");
      fs.writeFileSync(
        path.join(dir, "quota.json"),
        JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
      );
      const svc = new QuotaService({
        authFilePath: path.join(dir, "auth.json"),
        quotaConfigPath: path.join(dir, "quota.json"),
        fetchFn: async (url: string | URL | Request) =>
          String(url).endsWith("/balance") ? jsonRes({ code, data: {} }) : jsonRes(MIMO_DETAIL),
      });
      const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
      expect(mimo.error).toContain(`接口返回 code ${code}`);
      if (expectHint) {
        expect(mimo.error).toContain("Cookie");
      } else {
        expect(mimo.error).not.toContain("Cookie");
      }
    }
  });

  it("MiMo 三个接口串行请求（任一时刻至多一个在途，避免钉死线程池）", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=svc; userId=123" } }),
    );
    let inFlight = 0;
    let peak = 0;
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: async (url: string | URL | Request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        const u = String(url);
        if (u.endsWith("/balance")) return jsonRes(MIMO_BALANCE);
        if (u.endsWith("/tokenPlan/detail")) return jsonRes(MIMO_DETAIL);
        return jsonRes(MIMO_USAGE);
      },
    });
    const mimo = (await svc.fetchAll()).providers.find((p) => p.providerId === "mimo")!;
    expect(peak).toBe(1);
    expect(mimo.error).toBeNull();
    expect(mimo.plan).toBe("lite");
  });
});

describe("quotaCycleFailed / quotaRetryDelayMs — 退避策略", () => {
  function snap(entries: Array<[configured: boolean, error: string | null]>): QuotaSnapshot {
    return {
      fetchedAt: "x",
      providers: entries.map(([configured, error], index) => ({
        providerId: "kimi" as const,
        label: `P${index}`,
        plan: null,
        windows: [],
        balances: null,
        configured,
        error,
      })),
    };
  }

  it("仅当所有已配置 provider 都出错且含传输类错误时才退避（纯 HTTP 错误快速失败不占线程池）", () => {
    expect(quotaCycleFailed(null)).toBe(true);
    expect(
      quotaCycleFailed(
        snap([
          [true, "HTTP 500"],
          [true, null],
        ]),
      ),
    ).toBe(false);
    expect(
      quotaCycleFailed(
        snap([
          [true, NETWORK_UNAVAILABLE_MESSAGE],
          [true, "HTTP 500"],
        ]),
      ),
    ).toBe(true);
    expect(
      quotaCycleFailed(
        snap([
          [true, NETWORK_TIMEOUT_MESSAGE],
          [true, NETWORK_UNAVAILABLE_MESSAGE],
        ]),
      ),
    ).toBe(true);
    expect(
      quotaCycleFailed(
        snap([
          [true, "HTTP 500"],
          [true, "HTTP 502"],
        ]),
      ),
    ).toBe(false);
    expect(
      quotaCycleFailed(
        snap([
          [true, null],
          [false, null],
        ]),
      ),
    ).toBe(false);
    expect(quotaCycleFailed(snap([[false, null]]))).toBe(false);
  });

  it("按失败次数指数退避，封顶 120 秒，且不低于配置基数；0 保持禁用", () => {
    expect(quotaRetryDelayMs(0, 3)).toBe(0);
    expect(quotaRetryDelayMs(30, 0)).toBe(30_000);
    expect(quotaRetryDelayMs(30, 1)).toBe(60_000);
    expect(quotaRetryDelayMs(30, 2)).toBe(120_000);
    expect(quotaRetryDelayMs(30, 9)).toBe(120_000);
    expect(quotaRetryDelayMs(300, 1)).toBe(300_000);
  });
});

describe("formatQuotaBar", () => {
  it("renders one segment per window in 5h→7d→30d order, provider name only on the first segment", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T00:00:00.000Z",
      providers: [
        {
          providerId: "kimi",
          label: "Kimi",
          plan: null,
          configured: true,
          error: null,
          balances: null,
          windows: [
            {
              kind: "weekly",
              usedPercent: 28,
              remainingPercent: 72,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
            {
              kind: "5h",
              usedPercent: 0,
              remainingPercent: 100,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
            {
              kind: "monthly",
              usedPercent: 40,
              remainingPercent: 60,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
          ],
        },
        {
          providerId: "glm",
          label: "GLM",
          plan: null,
          configured: true,
          error: null,
          balances: null,
          windows: [
            {
              kind: "5h",
              usedPercent: 9,
              remainingPercent: 91,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
          ],
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
      providers: [
        {
          providerId: "kimi",
          label: "Kimi",
          plan: null,
          configured: true,
          error: null,
          balances: null,
          windows: [
            {
              kind: "5h",
              usedPercent: 45,
              remainingPercent: 55,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
            {
              kind: "weekly",
              usedPercent: 85,
              remainingPercent: 15,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
            {
              kind: "monthly",
              usedPercent: 40,
              remainingPercent: 60,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
          ],
        },
      ],
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
        {
          providerId: "kimi",
          label: "Kimi",
          plan: null,
          configured: true,
          error: "HTTP 500",
          windows: [],
          balances: null,
        },
        { providerId: "mimo", label: "MiMo", plan: null, configured: false, error: null, windows: [], balances: null },
      ],
    });
    expect(errored.segments).toEqual([{ text: "Kimi ?", color: "neutral" }]);
    expect(formatQuotaBar({ fetchedAt: "x", providers: [] }).segments).toEqual([]);
  });

  it("renders staleFetchedAt providers with a ~ marker instead of ? (windows and balances)", () => {
    const bar = formatQuotaBar({
      fetchedAt: "2026-08-22T00:10:00.000Z",
      providers: [
        {
          providerId: "kimi",
          label: "Kimi",
          plan: null,
          configured: true,
          error: "网络不可用，请检查网络连接",
          staleFetchedAt: "2026-08-22T00:00:00.000Z",
          windows: [
            {
              kind: "5h",
              usedPercent: 45,
              remainingPercent: 55,
              used: null,
              limit: null,
              remaining: null,
              resetAt: null,
            },
          ],
          balances: null,
        },
        {
          providerId: "deepseek",
          label: "DeepSeek",
          plan: null,
          configured: true,
          error: "网络不可用，请检查网络连接",
          staleFetchedAt: "2026-08-22T00:00:00.000Z",
          windows: [],
          balances: { total: 110, currency: "CNY" },
        },
      ],
    });
    expect(bar.segments.map((seg) => [seg.text, seg.color])).toEqual([
      ["Kimi ~55%/5h", "yellow"],
      ["DeepSeek ~¥110", "green"],
    ]);
  });
});

describe("spliceStaleProviders — stale-while-error overlay", () => {
  const errored = (providerId: QuotaProviderId, error: string): ProviderQuota => ({
    providerId,
    label: providerId,
    plan: null,
    configured: true,
    error,
    windows: [],
    balances: null,
  });
  const good = (providerId: QuotaProviderId): ProviderQuota => ({
    providerId,
    label: providerId,
    plan: "pro",
    configured: true,
    error: null,
    windows: [
      { kind: "5h", usedPercent: 20, remainingPercent: 80, used: null, limit: null, remaining: null, resetAt: null },
    ],
    balances: null,
  });

  it("restores cached windows under an errored provider, keeping the fresh error and fetchedAt", () => {
    const now = Date.parse("2026-08-22T00:10:00.000Z");
    const lastGood = new Map([["kimi" as QuotaProviderId, { provider: good("kimi"), fetchedAtMs: now - 60_000 }]]);
    const fresh: QuotaSnapshot = {
      fetchedAt: "2026-08-22T00:10:00.000Z",
      providers: [errored("kimi", "网络不可用，请检查网络连接")],
    };
    const spliced = spliceStaleProviders(fresh, lastGood, now);
    expect(spliced.fetchedAt).toBe(fresh.fetchedAt);
    expect(spliced.providers[0]).toEqual({
      ...good("kimi"),
      error: "网络不可用，请检查网络连接",
      staleFetchedAt: "2026-08-22T00:09:00.000Z",
    });
  });

  it("keeps the bare error once the cache exceeds the age cap, and for contentless caches", () => {
    const now = Date.parse("2026-08-22T02:00:00.000Z");
    const tooOld = new Map([
      ["kimi" as QuotaProviderId, { provider: good("kimi"), fetchedAtMs: now - STALE_PROVIDER_MAX_AGE_MS - 1 }],
    ]);
    const contentless = new Map([
      ["glm" as QuotaProviderId, { provider: { ...errored("glm", "x"), error: null }, fetchedAtMs: now }],
    ]);
    const fresh: QuotaSnapshot = {
      fetchedAt: "2026-08-22T02:00:00.000Z",
      providers: [errored("kimi", "网络不可用，请检查网络连接"), errored("glm", "网络不可用，请检查网络连接")],
    };
    const spliced = spliceStaleProviders(fresh, new Map([...tooOld, ...contentless]), now);
    expect(spliced.providers[0]).toEqual(fresh.providers[0]); // too old → untouched
    expect(spliced.providers[1]).toEqual(fresh.providers[1]); // no windows/balances → untouched
  });

  it("leaves clean providers untouched", () => {
    const now = Date.parse("2026-08-22T00:10:00.000Z");
    const clean = good("kimi");
    const spliced = spliceStaleProviders({ fetchedAt: "t", providers: [clean] }, new Map(), now);
    expect(spliced.providers[0]).toBe(clean);
  });

  it("normalizes: a previously overlaid entry whose cache aged out degrades to the error-only form", () => {
    const now = Date.parse("2026-08-22T02:00:00.000Z");
    const lastGood = new Map([
      ["kimi" as QuotaProviderId, { provider: good("kimi"), fetchedAtMs: now - STALE_PROVIDER_MAX_AGE_MS - 1 }],
    ]);
    // Snapshot carrying an earlier overlay (solo-refresh paths keep old siblings).
    const overlaid: QuotaSnapshot = {
      fetchedAt: "2026-08-22T02:00:00.000Z",
      providers: [
        {
          ...errored("kimi", "网络不可用，请检查网络连接"),
          plan: "pro",
          windows: good("kimi").windows,
          staleFetchedAt: "2026-08-22T00:00:00.000Z",
        },
      ],
    };
    const spliced = spliceStaleProviders(overlaid, lastGood, now);
    expect(spliced.providers[0]).toEqual(errored("kimi", "网络不可用，请检查网络连接"));
  });
});

describe("providerHasDisplayData / quotaSnapshotDegraded", () => {
  const base = (overrides: Partial<ProviderQuota>): ProviderQuota => ({
    providerId: "kimi",
    label: "Kimi",
    plan: null,
    configured: true,
    error: null,
    windows: [],
    balances: null,
    ...overrides,
  });
  const nullWindow = {
    kind: "5h" as const,
    usedPercent: null,
    remainingPercent: null,
    used: null,
    limit: null,
    remaining: null,
    resetAt: null,
  };
  const realWindow = { ...nullWindow, usedPercent: 10, remainingPercent: 90 };

  it("accepts windows with derivable percents and real balances; rejects contentless shapes", () => {
    expect(providerHasDisplayData(base({ windows: [nullWindow] }))).toBe(false);
    expect(providerHasDisplayData(base({ windows: [realWindow] }))).toBe(true);
    // MiMo success with missing balance fields: balances present but empty → not display data.
    expect(providerHasDisplayData(base({ balances: { total: null, currency: null } }))).toBe(false);
    expect(providerHasDisplayData(base({ balances: { total: 12.34, currency: "CNY" } }))).toBe(true);
    expect(providerHasDisplayData(base({}))).toBe(false);
  });

  it("degraded = no snapshot, or any configured provider with an error (unconfigured errors do not count)", () => {
    expect(quotaSnapshotDegraded(null)).toBe(true);
    expect(quotaSnapshotDegraded({ fetchedAt: "t", providers: [] })).toBe(false);
    expect(quotaSnapshotDegraded({ fetchedAt: "t", providers: [base({})] })).toBe(false);
    expect(quotaSnapshotDegraded({ fetchedAt: "t", providers: [base({ error: "x" })] })).toBe(true);
    expect(quotaSnapshotDegraded({ fetchedAt: "t", providers: [base({ configured: false })] })).toBe(false);
  });
});

describe("QuotaService.saveMimoCookie", () => {
  function cookieSvc(dir: string): QuotaService {
    return new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "nested", "quota.json"),
    });
  }

  it("creates quota.json (mkdir on demand) with the normalized cookie, preserving other keys; mode 0600 on POSIX", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "quota.json"), JSON.stringify({ other: true, mimo: { lang: "en" } }));
    const svc = cookieSvc(dir);

    svc.saveMimoCookie("Cookie: junk=1; api-platform_serviceToken=abc; userId=42; other=x");

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "nested", "quota.json"), "utf8"));
    expect(saved).toEqual({ other: true, mimo: { lang: "en", cookie: "api-platform_serviceToken=abc; userId=42" } });
  });

  it.skipIf(process.platform === "win32")("marks the file owner-only (0600) after writing", () => {
    const dir = tmpDir();
    const svc = cookieSvc(dir);

    svc.saveMimoCookie("api-platform_serviceToken=abc; userId=42");

    const file = path.join(dir, "nested", "quota.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("heals a corrupt existing quota.json into valid JSON carrying the cookie", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "quota.json"), "{ not json !!!");
    const svc = cookieSvc(dir);

    svc.saveMimoCookie("api-platform_serviceToken=abc; userId=42");

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "nested", "quota.json"), "utf8"));
    expect(saved.mimo.cookie).toBe("api-platform_serviceToken=abc; userId=42");
  });

  it("throws MIMO_COOKIE_INVALID for cookies missing required parts", () => {
    const dir = tmpDir();
    const svc = cookieSvc(dir);

    expect(() => svc.saveMimoCookie("userId=42")).toThrow("MIMO_COOKIE_INVALID");
    expect(fs.existsSync(path.join(dir, "nested", "quota.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws CONFIG_UNREADABLE when quota.json exists but cannot be read",
    () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "nested"));
      const file = path.join(dir, "nested", "quota.json");
      fs.writeFileSync(file, "{}");
      fs.chmodSync(file, 0o000);
      const svc = cookieSvc(dir);

      try {
        expect(() => svc.saveMimoCookie("api-platform_serviceToken=abc; userId=42")).toThrow("CONFIG_UNREADABLE");
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );
});

describe("normalizeQuotaVisibility", () => {
  it("absent/garbage source yields all-visible", () => {
    const allVisible = { kimi: true, glm: true, mimo: true, deepseek: true };
    expect(normalizeQuotaVisibility(undefined)).toEqual(allVisible);
    expect(normalizeQuotaVisibility(null)).toEqual(allVisible);
    expect(normalizeQuotaVisibility("nope")).toEqual(allVisible);
    expect(normalizeQuotaVisibility([false, false])).toEqual(allVisible);
    expect(normalizeQuotaVisibility({})).toEqual(allVisible);
  });

  it("only a strict false hides; true/absent/invalid values stay visible", () => {
    expect(normalizeQuotaVisibility({ kimi: false })).toEqual({ kimi: false, glm: true, mimo: true, deepseek: true });
    expect(normalizeQuotaVisibility({ kimi: "false", glm: 0 })).toEqual({
      kimi: true,
      glm: true,
      mimo: true,
      deepseek: true,
    });
    expect(normalizeQuotaVisibility({ unknown: false, mimo: false })).toEqual({
      kimi: true,
      glm: true,
      mimo: false,
      deepseek: true,
    });
  });
});

describe("readQuotaStatusBarVisibility", () => {
  it("reads the persisted sparse map; missing file/keys/corrupt content → all visible", () => {
    const dir = tmpDir();
    const file = path.join(dir, "quota.json");

    expect(readQuotaStatusBarVisibility(file, fs)).toEqual({ kimi: true, glm: true, mimo: true, deepseek: true });

    fs.writeFileSync(file, JSON.stringify({ statusBar: { kimi: false, glm: true } }));
    expect(readQuotaStatusBarVisibility(file, fs)).toEqual({ kimi: false, glm: true, mimo: true, deepseek: true });

    fs.writeFileSync(file, "{ corrupt");
    expect(readQuotaStatusBarVisibility(file, fs)).toEqual({ kimi: true, glm: true, mimo: true, deepseek: true });

    fs.writeFileSync(file, JSON.stringify({ mimo: { cookie: "x" } }));
    expect(readQuotaStatusBarVisibility(file, fs)).toEqual({ kimi: true, glm: true, mimo: true, deepseek: true });
  });
});

describe("QuotaService.saveQuotaStatusBarProvider", () => {
  function visSvc(dir: string): QuotaService {
    return new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "nested", "quota.json"),
    });
  }

  it("persists the toggle while preserving the MiMo cookie and unknown keys; returns the full record", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "nested"));
    const file = path.join(dir, "nested", "quota.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        other: 1,
        mimo: { cookie: "api-platform_serviceToken=abc; userId=42" },
        statusBar: { glm: false },
      }),
    );
    const svc = visSvc(dir);

    const visibility = svc.saveQuotaStatusBarProvider("kimi", false);

    expect(visibility).toEqual({ kimi: false, glm: false, mimo: true, deepseek: true });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.other).toBe(1);
    expect(saved.mimo.cookie).toBe("api-platform_serviceToken=abc; userId=42");
    expect(saved.statusBar).toEqual({ kimi: false, glm: false, mimo: true, deepseek: true });
  });

  it("creating the file fresh (mkdir on demand) and toggling back to visible round-trips", () => {
    const dir = tmpDir();
    const svc = visSvc(dir);

    expect(svc.saveQuotaStatusBarProvider("mimo", false).mimo).toBe(false);
    expect(svc.saveQuotaStatusBarProvider("mimo", true)).toEqual({
      kimi: true,
      glm: true,
      mimo: true,
      deepseek: true,
    });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "nested", "quota.json"), "utf8"));
    expect(saved.statusBar).toEqual({ kimi: true, glm: true, mimo: true, deepseek: true });
  });

  it.skipIf(process.platform === "win32")("keeps the credential file owner-only (0600) after the atomic write", () => {
    const dir = tmpDir();
    const svc = visSvc(dir);

    svc.saveQuotaStatusBarProvider("kimi", false);

    const file = path.join(dir, "nested", "quota.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("heals a corrupt existing quota.json and readStatusBarVisibility sees the saved value", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "nested"));
    const file = path.join(dir, "nested", "quota.json");
    fs.writeFileSync(file, "{ not json");
    const svc = visSvc(dir);

    svc.saveQuotaStatusBarProvider("glm", false);

    expect(readQuotaStatusBarVisibility(file, fs).glm).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws CONFIG_UNREADABLE when quota.json exists but cannot be read",
    () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "nested"));
      const file = path.join(dir, "nested", "quota.json");
      fs.writeFileSync(file, "{}");
      fs.chmodSync(file, 0o000);
      const svc = visSvc(dir);

      try {
        expect(() => svc.saveQuotaStatusBarProvider("kimi", false)).toThrow("CONFIG_UNREADABLE");
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );
});

describe("QuotaService.fetchAll — provider subset", () => {
  it("fetches only the requested providers; empty subset issues zero requests", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "kimi-for-coding": { type: "api", key: "k" },
        "zhipuai-coding-plan": { type: "api", key: "g" },
      }),
    );
    const urls: string[] = [];
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      fetchFn: (input) => {
        urls.push(String(input));
        return Promise.resolve(jsonRes({ usage: { limit: 10, remaining: 5 } }));
      },
    });

    const subset = await svc.fetchAll(["kimi"]);
    expect(subset.providers.map((provider) => provider.providerId)).toEqual(["kimi"]);

    const empty = await svc.fetchAll([]);
    expect(empty.providers).toEqual([]);
    expect(urls.every((url) => url.includes("api.kimi.com"))).toBe(true);
  });

  it("unknown ids in the subset are dropped", async () => {
    const dir = tmpDir();
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      fetchFn: () => Promise.resolve(jsonRes({})),
    });

    const snapshot = await svc.fetchAll(["nonsense" as QuotaProviderId, "deepseek"]);
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual(["deepseek"]);
  });
});

describe("deriveRemainingPercent", () => {
  function window(partial: Partial<QuotaWindow>): QuotaWindow {
    return {
      kind: "weekly",
      usedPercent: null,
      remainingPercent: null,
      used: null,
      limit: null,
      remaining: null,
      resetAt: null,
      ...partial,
    };
  }

  it("prefers the API-provided remainingPercent", () => {
    expect(deriveRemainingPercent(window({ remainingPercent: 72, usedPercent: 28 }))).toBe(72);
  });

  it("derives from usedPercent (one decimal) when remainingPercent is null", () => {
    expect(deriveRemainingPercent(window({ usedPercent: 33.3 }))).toBe(66.7);
    expect(deriveRemainingPercent(window({ usedPercent: 0 }))).toBe(100);
  });

  it("returns null when both percents are unknown", () => {
    expect(deriveRemainingPercent(window({}))).toBeNull();
  });
});

describe("QuotaService.fetchProvider", () => {
  function providerBase(id: ProviderQuota["providerId"], label: string): ProviderQuota {
    return { providerId: id, label, plan: null, windows: [], balances: null, configured: false, error: null };
  }

  it("refreshes a single provider from its credential and touches only its endpoint", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "kimi-for-coding": { type: "api", key: "sk-kimi" },
        "zhipuai-coding-plan": { type: "api", key: "sk-glm" },
      }),
    );
    const urls: string[] = [];
    const fetchFn = async (url: string | URL | Request): Promise<Response> => {
      urls.push(String(url));
      return jsonRes(KIMI_PAYLOAD);
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn,
    });

    const kimi = await svc.fetchProvider("kimi");

    expect(urls).toEqual(["https://api.kimi.com/coding/v1/usages"]);
    expect(kimi.configured).toBe(true);
    expect(kimi.plan).toBe("Allegretto");
  });

  it("reports an unconfigured provider without any network request", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } }));
    let calls = 0;
    const fetchFn = async (): Promise<Response> => {
      calls += 1;
      return jsonRes({});
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn,
    });

    const deepseek = await svc.fetchProvider("deepseek");

    expect(calls).toBe(0);
    expect(deepseek).toEqual(providerBase("deepseek", "DeepSeek"));
  });

  it("reads the MiMo cookie from quota.json for a mimo refresh", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=abc; userId=42" } }),
    );
    const urls: string[] = [];
    const fetchFn = async (url: string | URL | Request): Promise<Response> => {
      const href = String(url);
      urls.push(href);
      if (href.endsWith("/balance")) {
        return jsonRes(MIMO_BALANCE);
      }
      if (href.endsWith("/tokenPlan/detail")) {
        return jsonRes(MIMO_DETAIL);
      }
      return jsonRes(MIMO_USAGE);
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn,
    });

    const mimo = await svc.fetchProvider("mimo");

    expect(urls).toEqual([
      "https://platform.xiaomimimo.com/api/v1/balance",
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail",
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
    ]);
    expect(mimo.configured).toBe(true);
    expect(mimo.plan).toBe("lite");
    expect(mimo.balances).toEqual({ total: 12.34, currency: "CNY" });
  });

  it("maps transport failures to the friendly message for a single provider too", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "k" } }));
    const fetchFn = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn,
    });

    const deepseek = await svc.fetchProvider("deepseek");

    expect(deepseek.configured).toBe(true);
    expect(deepseek.error).toBe(NETWORK_UNAVAILABLE_MESSAGE);
  });
});

describe("mergeProviderSnapshot", () => {
  function provider(id: ProviderQuota["providerId"], configured = true): ProviderQuota {
    return { providerId: id, label: id, plan: null, windows: [], balances: null, configured, error: null };
  }

  it("replaces the matching provider in place, preserving order and siblings", () => {
    const snapshot: QuotaSnapshot = {
      providers: [provider("kimi"), provider("glm"), provider("mimo"), provider("deepseek")],
      fetchedAt: "2026-08-25T00:00:00.000Z",
    };
    const fresh = { ...provider("glm"), plan: "pro" };

    const merged = mergeProviderSnapshot(snapshot, fresh, "2026-08-25T01:00:00.000Z");

    expect(merged.providers.map((p) => p.providerId)).toEqual(["kimi", "glm", "mimo", "deepseek"]);
    expect(merged.providers[1].plan).toBe("pro");
    expect(merged.fetchedAt).toBe("2026-08-25T01:00:00.000Z");
  });

  it("inserts an unknown provider at its canonical-order position", () => {
    const snapshot: QuotaSnapshot = { providers: [provider("kimi")], fetchedAt: "2026-08-25T00:00:00.000Z" };

    const merged = mergeProviderSnapshot(snapshot, provider("glm"), "2026-08-25T02:00:00.000Z");

    expect(merged.providers.map((p) => p.providerId)).toEqual(["kimi", "glm"]);
  });
});

describe("QuotaService — request gate (libuv threadpool protection)", () => {
  function allConfiguredDir(): string {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        "kimi-for-coding": { type: "api", key: "k" },
        "zhipuai-coding-plan": { type: "api", key: "g" },
        deepseek: { type: "api", key: "d" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "quota.json"),
      JSON.stringify({ mimo: { cookie: "api-platform_serviceToken=abc; userId=42" } }),
    );
    return dir;
  }

  function trackingFetch(delays: Record<string, number>) {
    let active = 0;
    let peak = 0;
    const state = {
      peak: 0,
      fetchFn: async (url: string | URL | Request): Promise<Response> => {
        active += 1;
        peak = Math.max(peak, active);
        state.peak = peak;
        const href = String(url);
        const delay =
          delays[
            href.endsWith("/usages")
              ? "kimi"
              : href.includes("bigmodel")
                ? "glm"
                : href.includes("xiaomimimo")
                  ? "mimo"
                  : "deepseek"
          ] ?? 20;
        await new Promise((resolve) => setTimeout(resolve, delay));
        active -= 1;
        if (href.endsWith("/usages")) {
          return jsonRes(KIMI_PAYLOAD);
        }
        if (href.includes("bigmodel")) {
          return jsonRes(GLM_PAYLOAD);
        }
        if (href.endsWith("/balance")) {
          return jsonRes(MIMO_BALANCE);
        }
        if (href.endsWith("/tokenPlan/detail")) {
          return jsonRes(MIMO_DETAIL);
        }
        if (href.endsWith("/tokenPlan/usage")) {
          return jsonRes(MIMO_USAGE);
        }
        return jsonRes({ balance_infos: [{ currency: "CNY", total_balance: "5" }] });
      },
    };
    return state;
  }

  it("fetchAll keeps at most 2 provider requests in flight by default", async () => {
    const dir = allConfiguredDir();
    const track = trackingFetch({ kimi: 40, glm: 40, mimo: 40, deepseek: 40 });
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: track.fetchFn,
    });

    await svc.fetchAll();

    expect(track.peak).toBeLessThanOrEqual(2);
  });

  it("maxConcurrentRequests:1 serializes provider requests completely", async () => {
    const dir = allConfiguredDir();
    const track = trackingFetch({ kimi: 30, glm: 30, mimo: 30, deepseek: 30 });
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: track.fetchFn,
      maxConcurrentRequests: 1,
    });

    const started = Date.now();
    await svc.fetchAll();
    const elapsed = Date.now() - started;

    expect(track.peak).toBe(1);
    // 6 requests total (kimi+glm+deepseek in parallel batches of 1, mimo 3 serial):
    // strictly serialized wall time ≥ 6 × 30ms − scheduling slack.
    expect(elapsed).toBeGreaterThanOrEqual(6 * 30 - 5);
  });

  it("manual fetchProvider shares the gate with an in-flight fetchAll", async () => {
    const dir = allConfiguredDir();
    const track = trackingFetch({ kimi: 60, glm: 20, mimo: 20, deepseek: 20 });
    const svc = new QuotaService({
      authFilePath: path.join(dir, "auth.json"),
      quotaConfigPath: path.join(dir, "quota.json"),
      fetchFn: track.fetchFn,
    });

    await Promise.all([svc.fetchAll(), svc.fetchProvider("deepseek")]);

    expect(track.peak).toBeLessThanOrEqual(2);
  });
});

describe("quotaShouldPauseAutoRefresh (circuit breaker)", () => {
  it("pauses only after the configured consecutive transport-failure streak", () => {
    expect(quotaShouldPauseAutoRefresh(0)).toBe(false);
    expect(quotaShouldPauseAutoRefresh(1)).toBe(false);
    expect(quotaShouldPauseAutoRefresh(2)).toBe(false);
    expect(quotaShouldPauseAutoRefresh(QUOTA_PAUSE_AFTER_STREAK)).toBe(true);
    expect(quotaShouldPauseAutoRefresh(QUOTA_PAUSE_AFTER_STREAK + 5)).toBe(true);
  });
});
