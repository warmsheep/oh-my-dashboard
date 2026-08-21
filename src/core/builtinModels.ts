import * as defaultFs from "node:fs";
import * as path from "node:path";
import type { ModelOption } from "./types";

export const LOCAL_MODELS_FILE = "models.json";

/**
 * Built-in catalog of current mainstream models (GLM / Kimi / MiniMax / Mimo /
 * DeepSeek / GPT / Claude / Grok / Gemini). Seeded into <configDir>/models.json
 * on first use; edit that file to add or remove entries. Update this list and
 * repackage the extension to ship a newer catalog.
 */
export const BUILTIN_MODELS: readonly ModelOption[] = [
  { id: "zhipuai-coding-plan/glm-5.2", provider: "zhipuai-coding-plan", model: "glm-5.2", label: "GLM-5.2" },
  { id: "zhipuai-coding-plan/glm-5.2-air", provider: "zhipuai-coding-plan", model: "glm-5.2-air", label: "GLM-5.2 Air" },
  { id: "zhipuai-coding-plan/glm-4.6v", provider: "zhipuai-coding-plan", model: "glm-4.6v", label: "GLM-4.6V（视觉）" },
  { id: "moonshotai/kimi-k2.5", provider: "moonshotai", model: "kimi-k2.5", label: "Kimi K2.5" },
  { id: "minimax-cn-coding-plan/MiniMax-M2.5", provider: "minimax-cn-coding-plan", model: "MiniMax-M2.5", label: "MiniMax M2.5" },
  { id: "xiaomi/mimo-2", provider: "xiaomi", model: "mimo-2", label: "MiMo 2" },
  { id: "deepseek/DeepSeek-V4", provider: "deepseek", model: "DeepSeek-V4", label: "DeepSeek V4" },
  { id: "deepseek/DeepSeek-R2", provider: "deepseek", model: "DeepSeek-R2", label: "DeepSeek R2" },
  { id: "openai/gpt-5.5", provider: "openai", model: "gpt-5.5", label: "GPT-5.5" },
  { id: "openai/gpt-5.5-codex", provider: "openai", model: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
  { id: "anthropic/claude-opus-4.6", provider: "anthropic", model: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "anthropic/claude-sonnet-4.6", provider: "anthropic", model: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "xai/grok-4.1", provider: "xai", model: "grok-4.1", label: "Grok 4.1" },
  { id: "google/gemini-3-pro", provider: "google", model: "gemini-3-pro", label: "Gemini 3 Pro" },
  { id: "google/gemini-2.5-flash", provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

function isModelOption(value: unknown): value is ModelOption {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.provider === "string" && typeof v.model === "string" && v.provider.length > 0 && v.model.length > 0;
}

function normalize(value: unknown): ModelOption | null {
  if (!isModelOption(value)) {
    return null;
  }
  const v = value as { provider: string; model: string; label?: unknown; id?: unknown };
  const id = typeof v.id === "string" && v.id.length > 0 ? v.id : `${v.provider}/${v.model}`;
  const label = typeof v.label === "string" && v.label.length > 0 ? v.label : v.model;
  return { id, provider: v.provider, model: v.model, label };
}

function serialize(models: readonly ModelOption[]): string {
  return (
    JSON.stringify(
      {
        models: models.map((m) => ({ provider: m.provider, model: m.model, label: m.label })),
      },
      null,
      2,
    ) + "\n"
  );
}

function parseLocalModels(text: string): ModelOption[] {
  try {
    const parsed = JSON.parse(text) as { models?: unknown };
    const models = Array.isArray(parsed?.models) ? parsed.models.map(normalize).filter((m): m is ModelOption => m !== null) : [];
    return models;
  } catch {
    return [];
  }
}

/**
 * Read the local model catalog from <configDir>/models.json, creating it from
 * BUILTIN_MODELS when missing or unreadable (self-healing: the file is a
 * regenerable cache that users may also hand-edit).
 */
export function ensureLocalModelsFile(configDir: string, fs: typeof defaultFs = defaultFs): ModelOption[] {
  const file = path.join(configDir, LOCAL_MODELS_FILE);
  if (fs.existsSync(file)) {
    const models = parseLocalModels(fs.readFileSync(file, "utf8"));
    if (models.length > 0) {
      return models;
    }
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, serialize(BUILTIN_MODELS));
  return BUILTIN_MODELS.map((m) => ({ ...m }));
}

/**
 * Merge two model lists into one deduplicated catalog keyed by id. Entries from
 * `primary` (opencode.json providers) win over `secondary` (local catalog) when
 * ids collide; result is sorted by id.
 */
export function mergeModelOptions(primary: readonly ModelOption[], secondary: readonly ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const option of secondary) {
    byId.set(option.id, option);
  }
  for (const option of primary) {
    byId.set(option.id, option);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
