import { KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANT_ORDER } from "@shared/protocol";

/**
 * Canonical agent/category/variant lists now come from the frozen @shared/protocol
 * contract (bundled into the webview) — no third copy to keep in sync.
 */
export { KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANT_ORDER };

export interface SectionMeta {
  key: "agents" | "categories";
  title: string;
  icon: string;
  known: readonly string[];
}

export const SECTIONS: readonly SectionMeta[] = [
  { key: "agents", title: "智能体", icon: "🤖", known: KNOWN_AGENTS },
  {
    key: "categories",
    title: "分类",
    icon: "📦",
    known: KNOWN_CATEGORIES,
  },
];
