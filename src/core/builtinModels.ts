import * as defaultFs from "node:fs";
import * as path from "node:path";
import type { ModelOption } from "./types";

export const LOCAL_MODELS_FILE = "models.json";

/**
 * Built-in catalog of current mainstream models (GLM / Kimi / MiniMax / Mimo /
 * DeepSeek / GPT / Claude / Grok / Gemini), sourced from models.dev (the
 * opencode model catalog) on 2026-08-21. Seeded into <configDir>/models.json
 * on first use; edit that file to add or remove entries. Update this list and
 * repackage the extension to ship a newer catalog.
 */
export const BUILTIN_MODELS: readonly ModelOption[] = [
  { id: "zhipuai-coding-plan/glm-5.3", provider: "zhipuai-coding-plan", model: "glm-5.3", label: "GLM-5.3" },
  { id: "zhipuai-coding-plan/glm-5.2", provider: "zhipuai-coding-plan", model: "glm-5.2", label: "GLM-5.2" },
  { id: "zhipuai-coding-plan/glm-5.2-highspeed", provider: "zhipuai-coding-plan", model: "glm-5.2-highspeed", label: "GLM-5.2 高速" },
  { id: "zhipuai-coding-plan/glm-5v-turbo", provider: "zhipuai-coding-plan", model: "glm-5v-turbo", label: "GLM-5V Turbo（视觉）" },
  { id: "zhipuai-coding-plan/glm-4.6v", provider: "zhipuai-coding-plan", model: "glm-4.6v", label: "GLM-4.6V（视觉）" },
  { id: "kimi-for-coding/k3", provider: "kimi-for-coding", model: "k3", label: "Kimi K3" },
  { id: "kimi-for-coding/k3-256k", provider: "kimi-for-coding", model: "k3-256k", label: "Kimi K3 256K" },
  { id: "kimi-for-coding/kimi-for-coding-highspeed", provider: "kimi-for-coding", model: "kimi-for-coding-highspeed", label: "Kimi For Coding 高速" },
  { id: "minimax-cn-coding-plan/MiniMax-M3", provider: "minimax-cn-coding-plan", model: "MiniMax-M3", label: "MiniMax M3" },
  { id: "minimax-cn-coding-plan/MiniMax-M2.7", provider: "minimax-cn-coding-plan", model: "MiniMax-M2.7", label: "MiniMax M2.7" },
  { id: "minimax-cn-coding-plan/MiniMax-M2.7-highspeed", provider: "minimax-cn-coding-plan", model: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 高速" },
  { id: "minimax-cn-coding-plan/MiniMax-M2.5", provider: "minimax-cn-coding-plan", model: "MiniMax-M2.5", label: "MiniMax M2.5" },
  { id: "xiaomi/mimo-v2.5-pro-ultraspeed", provider: "xiaomi", model: "mimo-v2.5-pro-ultraspeed", label: "MiMo v2.5 Pro 极速" },
  { id: "xiaomi/mimo-v2.5-pro", provider: "xiaomi", model: "mimo-v2.5-pro", label: "MiMo v2.5 Pro" },
  { id: "xiaomi/mimo-v2.5", provider: "xiaomi", model: "mimo-v2.5", label: "MiMo v2.5" },
  { id: "deepseek/deepseek-v4-pro", provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "deepseek/deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat" },
  { id: "deepseek/deepseek-reasoner", provider: "deepseek", model: "deepseek-reasoner", label: "DeepSeek Reasoner（推理）" },
  { id: "openai/gpt-5.6", provider: "openai", model: "gpt-5.6", label: "GPT-5.6" },
  { id: "openai/gpt-5.6-sol", provider: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "openai/gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "openai/gpt-5.6-terra", provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "openai/gpt-5.5-pro", provider: "openai", model: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
  { id: "openai/gpt-5.3-codex", provider: "openai", model: "gpt-5.3-codex", label: "GPT-5.3 Codex（代码）" },
  { id: "anthropic/claude-opus-5", provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5" },
  { id: "anthropic/claude-sonnet-5", provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "anthropic/claude-opus-4-8", provider: "anthropic", model: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "anthropic/claude-haiku-4-5", provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5（快速）" },
  { id: "xai/grok-4.6", provider: "xai", model: "grok-4.6", label: "Grok 4.6" },
  { id: "xai/grok-4.5", provider: "xai", model: "grok-4.5", label: "Grok 4.5" },
  { id: "xai/grok-4.3", provider: "xai", model: "grok-4.3", label: "Grok 4.3" },
  { id: "google/gemini-3.7-flash", provider: "google", model: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "google/gemini-3.6-flash", provider: "google", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "google/gemini-3.1-pro-preview", provider: "google", model: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "google/gemini-2.5-pro", provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
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
