import * as defaultFs from "node:fs";

import { BUILTIN_PROVIDERS, ensureLocalModelsFile, updateLocalModelsFromCatalog } from "./builtinModels";
import { friendlyRequestError, readJsonBody } from "./quotaService";
import type { ModelOption } from "./types";

/** opencode's official model catalog — the single source of model data (nothing is bundled). */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * The catalog is a single ~4MB JSON document; a manual update on a slow link must
 * not give up prematurely (quota's 10s would), but stays bounded so a black-holed
 * connection cannot park the request forever.
 */
export const MODEL_CATALOG_TIMEOUT_MS = 30_000;

/** Fetch injection for tests and the timeout override (default 30s). */
export interface ModelCatalogFetchOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Result of one catalog fetch: usable models plus upstream-retired ids. */
export interface FetchedCatalog {
  /** Usable models per provider (chat-capable: `tool_call` true and not deprecated). */
  providers: Map<string, ModelOption[]>;
  /** Ids models.dev marks `status: "deprecated"` — retired upstream; updates prune them. */
  deprecatedIds: Set<string>;
}

/**
 * Fetch models.dev's flat catalog and reduce it to the requested providers:
 * `{ [providerId]: { models: { [modelId]: { name?, status?, tool_call?, ... } } } }`.
 * Only models usable as coding-agent chat models are kept — `tool_call: true`
 * (drops TTS/image/video/embedding models, which cannot run agent loops) and
 * `status !== "deprecated"` (drops retired generations the provider API rejects).
 * Deprecated ids are collected separately so updates can prune them locally.
 * Providers missing from the catalog are simply absent — the caller surfaces them.
 */
export async function fetchModelCatalogs(
  providerIds: readonly string[],
  opts: ModelCatalogFetchOptions = {},
): Promise<FetchedCatalog> {
  const fetchFn = opts.fetchFn ?? fetch;
  const result: FetchedCatalog = { providers: new Map(), deprecatedIds: new Set() };
  if (providerIds.length === 0) {
    return result;
  }
  let payload: unknown;
  try {
    const res = await fetchFn(MODELS_DEV_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`接口返回 HTTP ${res.status}`);
    }
    payload = await readJsonBody(res);
  } catch (error) {
    throw new Error(friendlyRequestError(error));
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("模型目录返回了无法解析的内容");
  }
  const providers = payload as Record<string, unknown>;
  for (const providerId of new Set(providerIds)) {
    const entry = providers[providerId];
    const models = entry && typeof entry === "object" ? (entry as { models?: unknown }).models : undefined;
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      continue;
    }
    const options: ModelOption[] = [];
    for (const [modelId, config] of Object.entries(models as Record<string, unknown>)) {
      const cfg = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
      const id = `${providerId}/${modelId}`;
      if (cfg.status === "deprecated") {
        result.deprecatedIds.add(id);
        continue;
      }
      if (cfg.tool_call !== true) {
        continue;
      }
      const name = typeof cfg.name === "string" && cfg.name.length > 0 ? cfg.name : modelId;
      options.push({ id, provider: providerId, model: modelId, label: name });
    }
    if (options.length > 0) {
      result.providers.set(providerId, options);
    }
  }
  return result;
}

/** Options for {@link seedLocalModelsFromCatalog}: test injection for fetch/fs/timeout. */
export interface SeedOptions extends ModelCatalogFetchOptions {
  fs?: typeof defaultFs;
}

/**
 * Activation-time seeding: when the local catalog is empty (fresh install, or
 * models.json was removed), fetch models.dev for the builtin provider allowlist
 * and persist the result. A non-empty local catalog is a no-op — ongoing updates
 * stay manual (the 「更新模型清单」 command). Returns the ids that were added.
 */
export async function seedLocalModelsFromCatalog(configDir: string, opts: SeedOptions = {}): Promise<string[]> {
  const fsMod = opts.fs ?? defaultFs;
  if (ensureLocalModelsFile(configDir, fsMod).length > 0) {
    return [];
  }
  const fetched = await fetchModelCatalogs(BUILTIN_PROVIDERS, opts);
  const result = updateLocalModelsFromCatalog(configDir, fetched.providers, fetched.deprecatedIds, fsMod);
  return result.addedIds;
}
