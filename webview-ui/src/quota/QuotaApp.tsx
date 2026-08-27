import type { ExtToWebview, ProviderQuota, QuotaInitPayload, QuotaSnapshot } from "@shared/protocol";
import { formatQuotaResetTime, QUOTA_PROVIDER_IDS, quotaProviderLabel, quotaWindowLabel } from "@shared/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { hasVSCodeApi, postToHost } from "../vscode";
import {
  balanceText,
  balanceTone,
  cookiePlaceholder,
  formatFetchedAt,
  formatTokenCount,
  orderedWindows,
  progressPercent,
  windowRemaining,
} from "./helpers";

const ALL_PENDING_KEY = "__all__";

const DEV_SNAPSHOT: QuotaSnapshot = {
  fetchedAt: "2026-08-25T10:00:00.000Z",
  providers: [
    {
      providerId: "kimi",
      label: "Kimi",
      plan: "Allegretto",
      windows: [
        {
          kind: "5h",
          usedPercent: 8,
          remainingPercent: 92,
          used: 80_000,
          limit: 1_000_000,
          remaining: 920_000,
          resetAt: "2026-08-25T12:00:00Z",
        },
        {
          kind: "weekly",
          usedPercent: 28,
          remainingPercent: 72,
          used: 280_000,
          limit: 1_000_000,
          remaining: 720_000,
          resetAt: "2026-08-27T10:08:21Z",
        },
      ],
      balances: null,
      configured: true,
      error: null,
    },
    { providerId: "glm", label: "GLM", plan: "pro", windows: [], balances: null, configured: false, error: null },
    {
      providerId: "mimo",
      label: "MiMo",
      plan: null,
      windows: [],
      balances: { total: 12.34, currency: "CNY" },
      configured: true,
      error: null,
    },
    {
      providerId: "deepseek",
      label: "DeepSeek",
      plan: null,
      windows: [],
      balances: { total: 88.5, currency: "CNY" },
      configured: true,
      error: null,
    },
  ],
};

function ProviderGroup({
  providerId,
  provider,
  refreshing,
  cookie,
  cookieError,
  savingCookie,
  onCookieChange,
  onSaveCookie,
  onRefresh,
  groupRef,
}: {
  providerId: ProviderQuota["providerId"];
  provider: ProviderQuota | null;
  refreshing: boolean;
  cookie: string;
  cookieError: string | null;
  savingCookie: boolean;
  onCookieChange(value: string): void;
  onSaveCookie(): void;
  onRefresh(): void;
  groupRef(el: HTMLElement | null): void;
}) {
  const label = provider?.label ?? quotaProviderLabel(providerId);
  const stale = provider?.staleFetchedAt !== undefined;
  const badge = refreshing
    ? "刷新中…"
    : provider === null
      ? "待加载"
      : stale
        ? "数据较旧"
        : provider.configured
          ? "已配置"
          : "未配置";
  const showData = provider !== null && (provider.error === null || stale);
  const balance = showData ? balanceText(provider.balances) : null;
  const credHint =
    providerId === "mimo" || provider === null
      ? null
      : provider.configured
        ? "凭据已由 opencode 登录信息检测到（auth.json），更换请运行 opencode auth login"
        : "终端运行 opencode auth login 登录后自动检测";

  return (
    <section className="qgroup" ref={groupRef} data-provider={providerId}>
      <header className="qgroup-head">
        <h2>{label}</h2>
        {provider?.plan && <span className="qplan">{provider.plan}</span>}
        {credHint && (
          <span className="qcred-hint" title={credHint}>
            {credHint}
          </span>
        )}
        <span className={`qbadge ${provider?.configured ? "on" : ""}`}>{badge}</span>
        <button type="button" className="btn secondary qrefresh" disabled={refreshing} onClick={onRefresh}>
          ⟳ 刷新
        </button>
      </header>

      <div className="qgroup-body">
        {provider?.error && (
          <div className="banner-error" role="alert">
            <span className="banner-icon" aria-hidden="true">
              ⛔
            </span>
            {provider.staleFetchedAt !== undefined
              ? `显示 ${new Date(provider.staleFetchedAt).toLocaleString("zh-CN", { hour12: false })} 的旧数据：${provider.error}`
              : provider.error}
          </div>
        )}

        {showData &&
          orderedWindows(provider.windows).map((window) => {
            const remaining = windowRemaining(window);
            const fill = progressPercent(window);
            const amounts =
              window.used !== null && window.limit !== null
                ? `已用 ${formatTokenCount(window.used)} / ${formatTokenCount(window.limit)}`
                : "";
            return (
              <div className="qrow" key={window.kind}>
                <span className="qrow-label">{quotaWindowLabel(window.kind)}</span>
                <div className="qbar" role="img" aria-label={`${quotaWindowLabel(window.kind)} 已用 ${fill ?? "?"}%`}>
                  {fill !== null && (
                    <div
                      className={remaining ? `qbar-fill ${remaining.colorClass}` : "qbar-fill"}
                      style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
                    />
                  )}
                </div>
                {remaining ? (
                  <span className={`qpct ${remaining.colorClass}`}>{Math.round(remaining.percent)}% 剩余</span>
                ) : (
                  <span className="qpct">额度未知</span>
                )}
                <span className="qdetail">
                  {amounts && <span>{amounts}</span>}
                  <span>{formatQuotaResetTime(window.resetAt)}</span>
                </span>
              </div>
            );
          })}

        {showData && balance !== null && (
          <div className="qrow">
            <span className="qrow-label">余额{stale ? "（旧）" : ""}</span>
            <span className={`qpct ${balanceTone(provider.balances!.total!)}`}>{balance}</span>
            <span className="qdetail">
              <span>按量计费</span>
            </span>
          </div>
        )}

        {provider !== null && provider.error === null && provider.windows.length === 0 && balance === null && (
          <div className="empty">{provider.configured ? "暂无额度数据" : "未配置凭据"}</div>
        )}

        {providerId === "mimo" && (
          <div className="qconfig">
            <div className="qconfig-row">
              <label htmlFor={`cookie-${providerId}`}>Dashboard Cookie</label>
              <input
                id={`cookie-${providerId}`}
                className={`ctl${cookieError ? " invalid" : ""}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={cookiePlaceholder(provider?.configured ?? false)}
                value={cookie}
                onChange={(e) => onCookieChange(e.target.value)}
              />
              <button
                type="button"
                className="btn secondary"
                disabled={savingCookie || cookie.trim() === ""}
                onClick={onSaveCookie}
              >
                保存
              </button>
            </div>
            {cookieError && (
              <div className="banner-error" role="alert">
                <span className="banner-icon" aria-hidden="true">
                  ⛔
                </span>
                {cookieError}
              </div>
            )}
            {!cookieError && (
              <p className="qhint">
                登录 platform.xiaomimimo.com → F12 → Network → 任选 /api/v1/balance 请求 → 复制请求头
                Cookie。留空保存不会修改现有值。
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default function QuotaApp() {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [cookie, setCookie] = useState("");
  const [savingCookie, setSavingCookie] = useState(false);
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const groupRefs = useRef<Partial<Record<ProviderQuota["providerId"], HTMLElement | null>>>({});

  const handleInit = useCallback((payload: QuotaInitPayload) => {
    setSnapshot(payload.snapshot);
    setPending(new Set());
    setSavingCookie(false);
    setCookieError(null);
    setStaleError(null);
    const focus = payload.focusProvider;
    if (focus !== undefined) {
      // Scroll after the render that consumes this snapshot.
      window.setTimeout(() => groupRefs.current[focus]?.scrollIntoView({ behavior: "smooth" }), 60);
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "quotaInit") {
        handleInit(msg.payload);
      } else if (msg.type === "quotaSnapshot") {
        // Host replies once per request; a snapshot also settles every pending marker.
        setSnapshot(msg.payload.snapshot);
        setPending(new Set());
        setStaleError(null);
      } else if (msg.type === "quotaPing") {
        // Liveness probe: answering proves this page's JS is still running.
        postToHost({ type: "pong" });
      } else if (msg.type === "quotaConfigSaved") {
        setSavingCookie(false);
        if (msg.payload.ok) {
          setCookie("");
          setCookieError(null);
          setToast("Cookie 已保存");
        } else {
          setCookieError(msg.payload.error ?? "保存失败，请重试");
        }
      }
    };
    window.addEventListener("message", onMessage);
    postToHost({ type: "ready" });
    if (!hasVSCodeApi()) {
      const t = window.setTimeout(() => handleInit({ snapshot: DEV_SNAPSHOT }), 60);
      return () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(t);
      };
    }
    return () => window.removeEventListener("message", onMessage);
  }, [handleInit]);

  // Stale-reply guard (mirror of the preset editor's awaitingResult timeout): without
  // it a lost host reply would leave buttons disabled forever. 35s covers the worst
  // legitimate request (MiMo = 3 sequential requests × 10s timeout + margin) — a page-
  // level transient banner, never the MiMo-scoped cookieError.
  useEffect(() => {
    if (pending.size === 0 && !savingCookie) {
      return;
    }
    const t = window.setTimeout(() => {
      setPending(new Set());
      setSavingCookie(false);
      setStaleError("请求无响应，请重试");
    }, 35_000);
    return () => window.clearTimeout(t);
  }, [pending, savingCookie]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  const requestRefresh = useCallback((providerId?: ProviderQuota["providerId"]) => {
    setPending((current) => new Set(current).add(providerId ?? ALL_PENDING_KEY));
    postToHost(providerId === undefined ? { type: "quotaRefresh" } : { type: "quotaRefresh", payload: { providerId } });
  }, []);

  const saveCookie = useCallback(() => {
    const value = cookie.trim();
    if (value === "" || savingCookie) {
      return;
    }
    setSavingCookie(true);
    setCookieError(null);
    postToHost({ type: "quotaSaveMimoCookie", payload: { cookie: value } });
  }, [cookie, savingCookie]);

  const byId = useMemo(() => {
    const map = new Map<ProviderQuota["providerId"], ProviderQuota>();
    for (const provider of snapshot?.providers ?? []) {
      map.set(provider.providerId, provider);
    }
    return map;
  }, [snapshot]);

  return (
    <main className="app">
      <div className="page quota-page">
        <header className="page-head">
          <h1>Coding Plan 额度</h1>
          <p>{snapshot ? formatFetchedAt(snapshot.fetchedAt) : "正在加载…"}</p>
        </header>

        {staleError && (
          <div className="banner-error" role="alert">
            <span className="banner-icon" aria-hidden="true">
              ⛔
            </span>
            {staleError}
          </div>
        )}

        {QUOTA_PROVIDER_IDS.map((id) => (
          <ProviderGroup
            key={id}
            providerId={id}
            provider={byId.get(id) ?? null}
            refreshing={pending.has(id) || pending.has(ALL_PENDING_KEY)}
            cookie={id === "mimo" ? cookie : ""}
            cookieError={id === "mimo" ? cookieError : null}
            savingCookie={savingCookie}
            onCookieChange={setCookie}
            onSaveCookie={saveCookie}
            onRefresh={() => requestRefresh(id)}
            groupRef={(el) => {
              groupRefs.current[id] = el;
            }}
          />
        ))}

        <div className="qfooter">
          <button
            type="button"
            className="btn primary"
            disabled={pending.has(ALL_PENDING_KEY)}
            onClick={() => requestRefresh()}
          >
            ⟳ 刷新全部
          </button>
        </div>
      </div>

      {toast && (
        <output className="toast" aria-live="polite">
          ✓&ensp;{toast}
        </output>
      )}
    </main>
  );
}
