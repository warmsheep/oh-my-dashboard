import type { ManagerTab } from "@shared/protocol";

/**
 * Validate an unknown persisted tab value (webview getState is untrusted storage):
 * anything other than the literal "settings" degrades to the quota tab — the
 * status-bar click target and the panel's primary purpose.
 */
export function normalizeManagerTab(value: unknown): ManagerTab {
  return value === "settings" ? "settings" : "quota";
}
