import type { ManagerTab } from "@shared/protocol";

/** Manager tabs in display order (the quota tab is the status-bar click target). */
export const MANAGER_TABS: readonly ManagerTab[] = ["quota", "settings", "preset"];

/**
 * Validate an unknown persisted tab value (webview getState is untrusted storage):
 * unknown values degrade to the quota tab — the status-bar click target and the
 * panel's primary purpose.
 */
export function normalizeManagerTab(value: unknown): ManagerTab {
  return value === "settings" || value === "preset" ? value : "quota";
}
