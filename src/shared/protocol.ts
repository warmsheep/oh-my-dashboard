/**
 * Frozen contract shared by the extension host and the webview UI. This module is
 * bundled on BOTH sides (webview via the @shared alias) and must stay dependency-free:
 * no runtime imports, no imports outside this directory, and never vscode or core here.
 */

export type Variant = "low" | "medium" | "high" | "xhigh" | "max";

/** The classic five reasoning levels; omo also accepts harness-native tokens beyond these. */
export const VARIANTS: readonly Variant[] = ["low", "medium", "high", "xhigh", "max"];

/** Canonical display order of the reasoning variants (webview dropdowns, tree rows). */
export const VARIANT_ORDER: readonly Variant[] = VARIANTS;

/** One selectable model in the merged catalog (opencode.json providers + local models.json). */
export interface ModelOption {
  id: string;
  provider: string;
  model: string;
  label: string;
}

/**
 * Canonical oh-my-openagent agent names, in display order. Single source of truth —
 * core/types.ts re-exports this for the extension side; the webview imports it via
 * the @shared alias (no third copy).
 */
export const KNOWN_AGENTS: readonly string[] = [
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus",
  "sisyphus-junior",
];

/** Canonical oh-my-openagent category names, in display order (see KNOWN_AGENTS). */
export const KNOWN_CATEGORIES: readonly string[] = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
  "architect",
  "backend",
  "frontend",
  "qa",
  "product",
];

export interface PresetRow {
  section: "agents" | "categories";
  name: string;
  model: string | null;
  /** Reasoning level; wider than the classic five variants (omo accepts "off"/"minimal"/...). */
  variant: string | null;
}

export interface WebviewInitPayload {
  preset: { name: string; description?: string; rows: PresetRow[] };
  models: ModelOption[];
}

export type ExtToWebview =
  | { type: "init"; payload: WebviewInitPayload }
  /** Sent when building/sending the init payload failed (e.g. listModels threw): replaces the boot screen with the error. */
  | { type: "initFailed"; payload: { error: string } }
  | { type: "modelsUpdated"; payload: { models: ModelOption[] } }
  | { type: "result"; payload: { action: "save" | "apply"; ok: boolean; error?: string } };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "dirty"; payload: boolean }
  | { type: "cancel" }
  | { type: "save"; payload: { name: string; description?: string; rows: PresetRow[]; apply: boolean } };
