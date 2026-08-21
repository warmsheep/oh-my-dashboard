import type { Variant } from "./helpers";

/**
 * Local copies of the known agent/category order (mirrors src/core/types.ts),
 * hardcoded on purpose: the webview must stay decoupled from extension code
 * beyond the frozen @shared/protocol contract.
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
];

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

export const VARIANT_ORDER: readonly Variant[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface SectionMeta {
  key: "agents" | "categories";
  title: string;
  icon: string;
  known: readonly string[];
}

export const SECTIONS: readonly SectionMeta[] = [
  { key: "agents", title: "Agents", icon: "🤖", known: KNOWN_AGENTS },
  {
    key: "categories",
    title: "Categories",
    icon: "📦",
    known: KNOWN_CATEGORIES,
  },
];
