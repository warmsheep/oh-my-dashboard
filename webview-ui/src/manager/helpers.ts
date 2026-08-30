import type { ManagerTab } from "@shared/protocol";

/** Manager tabs in display order (OMO · OpenCode · 额度 · 设置 · 模板 · 技能; quota stays the status-bar click target). */
export const MANAGER_TABS: readonly ManagerTab[] = ["config", "opencode", "quota", "settings", "preset", "skills"];

/**
 * Validate an unknown persisted tab value (webview getState is untrusted storage):
 * unknown values degrade to the quota tab — the status-bar click target and the
 * panel's primary purpose.
 */
export function normalizeManagerTab(value: unknown): ManagerTab {
  return value === "config" || value === "opencode" || value === "settings" || value === "preset" || value === "skills"
    ? value
    : "quota";
}
