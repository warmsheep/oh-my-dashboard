import * as vscode from "vscode";

import { CONFIG_SECTION } from "../constants";
import type { AutoRefreshSettings, AutoRefreshSettingsSource } from "../shared/protocol";
import {
  AUTO_REFRESH_CATEGORIES,
  AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
  normalizeAutoRefreshSettings,
  QUOTA_REFRESH_DEFAULT_SECONDS,
} from "../shared/protocol";

/**
 * Settings persistence for the settings page. vscode-dependent by design (config
 * read/write has no core seam); coverage lives in the e2e settings cases, same as
 * every other src/ui module.
 */

/** The subtree root keys this module owns; per-key leaves derive from them, never hand-duplicated. */
const AUTO_REFRESH_ROOT = "autoRefresh";
const QUOTA_ROOT = "quota";

/**
 * Read the auto-refresh settings from the VSCode configuration (merged user +
 * workspace), normalized: hand-edited garbage values clamp/fall back instead of
 * poisoning the scheduler. Unset keys resolve to the package.json defaults.
 */
export function readAutoRefreshSettings(): AutoRefreshSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const categories: NonNullable<AutoRefreshSettingsSource["categories"]> = {};
  for (const category of AUTO_REFRESH_CATEGORIES) {
    categories[category] = {
      enabled: config.get(`${AUTO_REFRESH_ROOT}.${category}.enabled`),
      intervalSeconds: config.get(`${AUTO_REFRESH_ROOT}.${category}.intervalSeconds`),
    };
  }
  return normalizeAutoRefreshSettings({
    categories,
    quotaRefreshSeconds: config.get(`${QUOTA_ROOT}.refreshSeconds`),
  });
}

/**
 * Write one leaf key in the scope that currently overrides it: a workspace-level
 * override would otherwise keep winning over every USER-scope write, bouncing the
 * page's toggles back to the workspace value (the user could never turn them
 * off). Leaves without a workspace override write the USER scope (this is
 * user-level tooling). update(key, undefined) REMOVES the override — values
 * equal to the registered default are written as undefined so an all-defaults
 * save leaves settings.json clean.
 */
function updateEffectiveScope(
  config: vscode.WorkspaceConfiguration,
  key: string,
  value: number | boolean | undefined,
): Thenable<void> {
  const target =
    config.inspect(key)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  return config.update(key, value, target);
}

/**
 * Persist the whole settings object. Per-key updates run in PARALLEL (one
 * settings-file round-trip window, so a save feels instant even over
 * code-server's remote settings channel); ordering across saves is guaranteed by
 * the host's save chain. The resulting onDidChangeConfiguration events re-arm
 * the scheduler and re-sync the open settings page.
 */
export async function writeAutoRefreshSettings(settings: AutoRefreshSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const updates: Thenable<void>[] = [
    updateEffectiveScope(
      config,
      `${QUOTA_ROOT}.refreshSeconds`,
      settings.quotaRefreshSeconds === QUOTA_REFRESH_DEFAULT_SECONDS ? undefined : settings.quotaRefreshSeconds,
    ),
  ];
  for (const category of AUTO_REFRESH_CATEGORIES) {
    const value = settings.categories[category];
    updates.push(
      updateEffectiveScope(config, `${AUTO_REFRESH_ROOT}.${category}.enabled`, value.enabled ? true : undefined),
      updateEffectiveScope(
        config,
        `${AUTO_REFRESH_ROOT}.${category}.intervalSeconds`,
        value.intervalSeconds === AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS ? undefined : value.intervalSeconds,
      ),
    );
  }
  await Promise.all(updates);
}
