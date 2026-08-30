import type { ExtToWebview, ManagerTab } from "@shared/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import App from "../App";
import ConfigApp from "../config/ConfigApp";
import OpenCodeApp from "../opencode/OpenCodeApp";
import QuotaApp from "../quota/QuotaApp";
import SettingsApp from "../settings/SettingsApp";
import SkillApp from "../skills/SkillApp";
import { getVSCodeApi, hasVSCodeApi, postToHost, setManagerTabState } from "../vscode";
import { MANAGER_TABS, normalizeManagerTab } from "./helpers";

function readPersistedTab(): ManagerTab {
  try {
    const state = getVSCodeApi().getState<{ managerTab?: unknown }>();
    return normalizeManagerTab(state?.managerTab);
  } catch {
    return "quota";
  }
}

const TAB_LABELS: Record<ManagerTab, string> = {
  config: "OMO",
  opencode: "OpenCode",
  quota: "额度",
  settings: "设置",
  preset: "模板",
  skills: "技能",
};

/**
 * Merged manager page: one tab bar, six always-mounted bodies (OMO/OpenCode/额度/设置/模板/技能).
 * The ROOT listener owns the `ready` handshake (sent once) and the `pong`
 * liveness answer — both must work regardless of the active tab, which is also
 * why the tab contents are CSS-toggled instead of unmounted (preset drafts,
 * cookie inputs, and pending markers survive tab switches).
 */
export default function ManagerApp() {
  const [tab, setTab] = useState<ManagerTab>(readPersistedTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const switchTab = useCallback((next: ManagerTab) => {
    setTab(next);
    setManagerTabState(next);
  }, []);

  // WAI-ARIA tabs pattern: roving focus — ArrowLeft/ArrowRight both switch and
  // move focus to the newly selected tab.
  const moveTab = (direction: 1 | -1): void => {
    const index = MANAGER_TABS.indexOf(tab);
    const next = MANAGER_TABS[(index + direction + MANAGER_TABS.length) % MANAGER_TABS.length];
    switchTab(next);
    tabRefs.current[MANAGER_TABS.indexOf(next)]?.focus();
  };
  const onTablistKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveTab(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveTab(-1);
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtToWebview | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      if (msg.type === "managerNavigate") {
        switchTab(normalizeManagerTab(msg.payload.tab));
      } else if (msg.type === "quotaPing") {
        // Liveness probe answered at the root: the page must prove its JS context
        // is alive no matter which tab is showing.
        postToHost({ type: "pong" });
      }
    };
    window.addEventListener("message", onMessage);
    postToHost({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [switchTab]);

  // Dev fallback so `vite dev` on manager.html shows content without a webview host.
  useEffect(() => {
    if (!hasVSCodeApi()) {
      const t = window.setTimeout(() => switchTab("quota"), 60);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [switchTab]);

  return (
    <main className="app">
      <div className="page manager-page">
        <header className="page-head">
          <h1>OpenCode 管理</h1>
          <p>OMO 模型配置 · OpenCode 设置 · Coding Plan 额度 · 扩展设置 · 模板矩阵编辑 · 技能清单</p>
        </header>

        <div className="mtabs" role="tablist" aria-label="管理页分区" onKeyDown={onTablistKeyDown}>
          {MANAGER_TABS.map((id, index) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`mtab-${id}`}
              className="mtab"
              aria-selected={tab === id}
              aria-controls={`mpanel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              onClick={() => switchTab(id)}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>

        <div
          id="mpanel-config"
          className="mtab-body"
          role="tabpanel"
          aria-labelledby="mtab-config"
          hidden={tab !== "config"}
        >
          <ConfigApp />
        </div>
        <div
          id="mpanel-opencode"
          className="mtab-body"
          role="tabpanel"
          aria-labelledby="mtab-opencode"
          hidden={tab !== "opencode"}
        >
          <OpenCodeApp />
        </div>
        <div
          id="mpanel-quota"
          className="mtab-body"
          role="tabpanel"
          aria-labelledby="mtab-quota"
          hidden={tab !== "quota"}
        >
          <QuotaApp />
        </div>
        <div
          id="mpanel-settings"
          className="mtab-body"
          role="tabpanel"
          aria-labelledby="mtab-settings"
          hidden={tab !== "settings"}
        >
          <SettingsApp />
        </div>
        <div
          id="mpanel-preset"
          className="mtab-body"
          role="tabpanel"
          aria-labelledby="mtab-preset"
          hidden={tab !== "preset"}
        >
          <App />
        </div>
        <div
          id="mpanel-skills"
          className="mtab-body"
          role="tabpanel"
          aria-labelledby="mtab-skills"
          hidden={tab !== "skills"}
        >
          <SkillApp />
        </div>
      </div>
    </main>
  );
}
