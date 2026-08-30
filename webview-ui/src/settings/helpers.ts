import type { AutoRefreshCategory, AutoRefreshSettings } from "@shared/protocol";
import {
  AUTO_REFRESH_CATEGORIES,
  AUTO_REFRESH_MAX_INTERVAL_SECONDS,
  AUTO_REFRESH_MIN_INTERVAL_SECONDS,
  normalizeAutoRefreshSettings,
  QUOTA_REFRESH_MAX_SECONDS,
  QUOTA_REFRESH_MIN_SECONDS,
} from "@shared/protocol";

/** Number-field identity used for focus tracking and draft text: a tree category or the quota interval. */
export type SettingsFieldKey = AutoRefreshCategory | "quota";

/** Parse text into an integer clamped to [min, max]; null when empty or non-numeric (keep raw text, send nothing). */
function parseSeconds(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Parse a section interval input (1–3600s); null when empty/NaN — the caller keeps the raw text and sends nothing. */
export function clampIntervalInput(raw: string): number | null {
  return parseSeconds(raw, AUTO_REFRESH_MIN_INTERVAL_SECONDS, AUTO_REFRESH_MAX_INTERVAL_SECONDS);
}

/** Parse the Coding Plan refresh interval (0–3600s, 0 disables the cycle); null when empty/NaN. */
export function clampQuotaInput(raw: string): number | null {
  return parseSeconds(raw, QUOTA_REFRESH_MIN_SECONDS, QUOTA_REFRESH_MAX_SECONDS);
}

/** Normalize the form into the well-formed save payload (wraps the shared normalizer). */
export function buildSettings(
  categories: Record<AutoRefreshCategory, { enabled: boolean; intervalSeconds: number }>,
  quotaRefreshSeconds: number,
): AutoRefreshSettings {
  return normalizeAutoRefreshSettings({ categories, quotaRefreshSeconds });
}

/** True when the working form differs from the last known persisted settings (drives the save button). */
export function isSettingsDirty(form: AutoRefreshSettings, saved: AutoRefreshSettings): boolean {
  if (form.quotaRefreshSeconds !== saved.quotaRefreshSeconds) {
    return true;
  }
  return AUTO_REFRESH_CATEGORIES.some(
    (category) =>
      form.categories[category].enabled !== saved.categories[category].enabled ||
      form.categories[category].intervalSeconds !== saved.categories[category].intervalSeconds,
  );
}

/**
 * Merge an external settings push into the page state: `saved` always adopts the
 * push (it is the persisted truth), while the working `form` adopts only fields
 * the user has NOT edited (fields where form still equals the old saved value).
 * Dirty fields keep the user's in-progress values so an external change can
 * never clobber unsaved edits.
 */
export function mergeIncomingSettings(
  incoming: AutoRefreshSettings,
  saved: AutoRefreshSettings,
  form: AutoRefreshSettings,
): { saved: AutoRefreshSettings; form: AutoRefreshSettings } {
  const categories = {} as Record<AutoRefreshCategory, { enabled: boolean; intervalSeconds: number }>;
  for (const category of AUTO_REFRESH_CATEGORIES) {
    const untouched =
      form.categories[category].enabled === saved.categories[category].enabled &&
      form.categories[category].intervalSeconds === saved.categories[category].intervalSeconds;
    categories[category] = untouched ? incoming.categories[category] : form.categories[category];
  }
  const quotaUntouched = form.quotaRefreshSeconds === saved.quotaRefreshSeconds;
  return {
    saved: incoming,
    form: {
      categories,
      quotaRefreshSeconds: quotaUntouched ? incoming.quotaRefreshSeconds : form.quotaRefreshSeconds,
    },
  };
}

/**
 * Keep only the focused field's raw draft when adopting a push, so in-progress typing
 * is never clobbered. The drafts map accepts any string keys (the settings page uses
 * SettingsFieldKey, the OMO/OpenCode tabs use plain setting keys); K pins the focused
 * field and the returned single-entry map.
 */
export function mergeIncomingDrafts<K extends string>(
  drafts: Readonly<Partial<Record<string, string>>>,
  focusedField: K | null,
): Partial<Record<K, string>> {
  if (focusedField === null || drafts[focusedField] === undefined) {
    return {};
  }
  const next: Partial<Record<K, string>> = {};
  next[focusedField] = drafts[focusedField];
  return next;
}
