import * as defaultFs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./atomicFile";
import { parseSafe } from "./jsoncEditor";
import type { ModelOption } from "./types";

export const LOCAL_MODELS_FILE = "models.json";

/**
 * Provider allowlist the plugin curates (coding-plan providers first, then
 * mainstream ones). NO models are bundled: models.json is populated from
 * models.dev (activation-time seeding + the 「更新模型清单」 command); with the
 * network down a fresh install simply starts with an empty catalog.
 */
export const BUILTIN_PROVIDERS: readonly string[] = [
  "zhipuai-coding-plan",
  "kimi-for-coding",
  "minimax-cn-coding-plan",
  "xiaomi-token-plan-cn",
  "opencode",
  "deepseek",
  "openai",
  "anthropic",
  "xai",
  "google",
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

function parseLocalModels(text: string): ModelOption[] | null {
  // models.json is hand-editable: tolerate comments/trailing commas (jsonc parse).
  // Returns null only for a broken SHAPE (value not an object / models not an
  // array) — the caller treats that as "corrupt file" (one-time .bak, rebuild on
  // the next network update); a valid empty array is a legitimate empty catalog.
  const { value } = parseSafe<{ models?: unknown }>(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!Array.isArray(value.models)) {
    return null;
  }
  return value.models.map(normalize).filter((m): m is ModelOption => m !== null);
}

function backupBrokenFile(file: string, fsMod: typeof defaultFs): ModelOption[] {
  // The network rebuild overwrites the file wholesale, so keep the user's broken
  // bytes as a one-time models.json.bak (repeated reads never re-copy).
  try {
    if (!fsMod.existsSync(`${file}.bak`)) {
      fsMod.copyFileSync(file, `${file}.bak`);
    }
  } catch {
    // best-effort backup; the empty-catalog degrade proceeds regardless
  }
  return [];
}

/**
 * Read the local model catalog from <configDir>/models.json. Pure read — nothing
 * is written or seeded here: the catalog's source of truth is the network
 * (models.dev, via activation-time seeding and the 「更新模型清单」 command), so a
 * missing or empty file simply yields [] and installing/upgrading the extension
 * never touches an existing models.json. A shape-broken file degrades to [] with
 * a one-time .bak so the eventual rebuild cannot destroy the user's bytes.
 */
export function ensureLocalModelsFile(configDir: string, fsMod: typeof defaultFs = defaultFs): ModelOption[] {
  const file = path.join(configDir, LOCAL_MODELS_FILE);
  if (!fsMod.existsSync(file)) {
    return [];
  }
  let text: string;
  try {
    text = fsMod.readFileSync(file, "utf8");
  } catch {
    // Exists but unreadable (permissions/AV lock): degrade read-only — a rewrite
    // would hit the same permission wall.
    return [];
  }
  const models = parseLocalModels(text);
  return models === null ? backupBrokenFile(file, fsMod) : models;
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

export interface LocalModelInput {
  provider: string;
  model: string;
  label?: string;
}

function writeLocalModels(configDir: string, models: ModelOption[], fsMod: typeof defaultFs = defaultFs): void {
  const file = path.join(configDir, LOCAL_MODELS_FILE);
  fsMod.mkdirSync(configDir, { recursive: true });
  writeFileAtomic(file, serialize(models), fsMod);
}

/** Add (or replace by id) an entry in the local catalog and persist models.json atomically. */
export function addLocalModel(
  configDir: string,
  input: LocalModelInput,
  fsMod: typeof defaultFs = defaultFs,
): ModelOption {
  const models = ensureLocalModelsFile(configDir, fsMod);
  const entry: ModelOption = {
    id: `${input.provider}/${input.model}`,
    provider: input.provider,
    model: input.model,
    label: input.label !== undefined && input.label.length > 0 ? input.label : input.model,
  };
  const index = models.findIndex((m) => m.id === entry.id);
  if (index >= 0) {
    models[index] = entry;
  } else {
    models.push(entry);
  }
  writeLocalModels(configDir, models, fsMod);
  return entry;
}

/**
 * Remove a model by id from the local catalog. Removing the last entry deletes
 * models.json (absence = "not populated"; the next activation's network seed may
 * fetch a fresh catalog); returns false for unknown ids.
 */
export function removeLocalModel(configDir: string, id: string, fsMod: typeof defaultFs = defaultFs): boolean {
  const models = ensureLocalModelsFile(configDir, fsMod);
  const next = models.filter((m) => m.id !== id);
  if (next.length === models.length) {
    return false;
  }
  if (next.length === 0) {
    // An empty models.json is valid (reads as an empty catalog), but deleting keeps
    // the on-disk story simple: absence means "not populated" and the next
    // activation's network seed may fetch a fresh catalog.
    fsMod.rmSync(path.join(configDir, LOCAL_MODELS_FILE), { force: true });
    return true;
  }
  writeLocalModels(configDir, next, fsMod);
  return true;
}

export interface CatalogMergeResult {
  merged: ModelOption[];
  /** Fresh ids that were not in the local catalog before. */
  addedIds: string[];
  /** Local ids whose fetched replacement differs in content (label/provider/model). */
  refreshedIds: string[];
  /** Local ids removed because models.dev marks them deprecated (upstream-retired). */
  prunedIds: string[];
}

/**
 * Pure merge of fetched catalog entries into the local list: fresh entries win on id
 * collisions and append new ids; local entries whose id is NOT upstream survive —
 * those are either the user's hand-added models (「添加模型…」) or ids the catalog no
 * longer lists at all, and neither may be dropped silently. The ONE deletion path is
 * `deprecatedIds`: ids models.dev explicitly marks retired are provably unusable, so
 * they are pruned (a stale extra QuickPick option is harmless, but a retired model
 * errors on every call — and the user cannot distinguish it from a working one).
 * `refreshedIds` counts only CONTENT-differing replacements, so added+refreshed+
 * pruned all empty ⟺ the catalog is byte-for-byte unchanged (order-insensitive).
 */
export function mergeCatalogIntoLocal(
  local: readonly ModelOption[],
  fetched: ReadonlyMap<string, ModelOption[]>,
  deprecatedIds: ReadonlySet<string> = new Set(),
): CatalogMergeResult {
  const fresh = [...fetched.values()].flat();
  const freshIds = new Set(fresh.map((m) => m.id));
  const localById = new Map(local.map((m) => [m.id, m]));
  const localIds = new Set(local.map((m) => m.id));
  const merged = [...local.filter((m) => !freshIds.has(m.id) && !deprecatedIds.has(m.id)), ...fresh];
  const contentDiffers = (fresh: ModelOption): boolean => {
    const prev = localById.get(fresh.id);
    return (
      prev !== undefined &&
      (prev.provider !== fresh.provider || prev.model !== fresh.model || prev.label !== fresh.label)
    );
  };
  return {
    merged,
    addedIds: fresh.filter((m) => !localIds.has(m.id)).map((m) => m.id),
    refreshedIds: fresh.filter((m) => localIds.has(m.id) && contentDiffers(m)).map((m) => m.id),
    prunedIds: local.filter((m) => deprecatedIds.has(m.id)).map((m) => m.id),
  };
}

/**
 * Persist the fetched catalog into <configDir>/models.json (seed + merge + prune +
 * atomic write); returns the merge result so the command layer can report counts.
 * Writes only on a real change — identical content (order-insensitive) never
 * re-serializes the file, so hand-edited JSONC comments survive no-op updates.
 * A prune-to-empty deletes the file (absence is the canonical empty catalog, same
 * as removeLocalModel).
 */
export function updateLocalModelsFromCatalog(
  configDir: string,
  fetched: ReadonlyMap<string, ModelOption[]>,
  deprecatedIds: ReadonlySet<string> = new Set(),
  fsMod: typeof defaultFs = defaultFs,
): CatalogMergeResult {
  const local = ensureLocalModelsFile(configDir, fsMod);
  const result = mergeCatalogIntoLocal(local, fetched, deprecatedIds);
  const changed = result.addedIds.length > 0 || result.refreshedIds.length > 0 || result.prunedIds.length > 0;
  if (changed && result.merged.length === 0) {
    fsMod.rmSync(path.join(configDir, LOCAL_MODELS_FILE), { force: true });
  } else if (changed) {
    writeLocalModels(configDir, result.merged, fsMod);
  }
  return result;
}
