import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addLocalModel,
  ensureLocalModelsFile,
  mergeCatalogIntoLocal,
  updateLocalModelsFromCatalog,
} from "../../src/core/builtinModels";
import { fetchModelCatalogs, MODELS_DEV_API_URL, seedLocalModelsFromCatalog } from "../../src/core/modelCatalog";
import { NETWORK_TIMEOUT_MESSAGE } from "../../src/core/quotaService";
import type { ModelOption } from "../../src/core/types";

const sandboxes: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelcatalog-"));
  sandboxes.push(dir);
  return dir;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fetchModelCatalogs", () => {
  const payload = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5", tool_call: true },
        "claude-sonnet-5": { id: "claude-sonnet-5", tool_call: true }, // no name → fallback to model id
        "claude-opus-4-1": { name: "Claude Opus 4.1", tool_call: true, status: "deprecated" },
        "claude-tts": { name: "Claude TTS", tool_call: false },
        "claude-beta": { name: "Claude Beta", tool_call: true, status: "beta" }, // beta is usable
        "claude-legacy": { name: "Claude Legacy" }, // missing tool_call → not agent-capable
      },
    },
    openai: { id: "openai", name: "OpenAI", models: { "gpt-5.6": { name: "GPT-5.6", tool_call: true } } },
    broken: { id: "broken", models: "not-an-object" },
    empty: { id: "empty", models: {} },
    alldeprecated: { id: "alldeprecated", models: { old: { tool_call: true, status: "deprecated" } } },
  };

  it("keeps only tool-callable non-deprecated models and collects deprecated ids", async () => {
    const fetched = await fetchModelCatalogs(["anthropic", "alldeprecated", "missing", "broken", "empty"], {
      fetchFn: async () => jsonRes(payload),
    });
    expect(fetched.providers.size).toBe(1); // alldeprecated has no usable model → absent
    expect(fetched.providers.get("anthropic")).toEqual([
      { id: "anthropic/claude-opus-5", provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5" },
      { id: "anthropic/claude-sonnet-5", provider: "anthropic", model: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "anthropic/claude-beta", provider: "anthropic", model: "claude-beta", label: "Claude Beta" },
    ]);
    expect([...fetched.deprecatedIds].sort()).toEqual(["alldeprecated/old", "anthropic/claude-opus-4-1"]);
  });

  it("issues one request against models.dev and skips the network entirely for no providers", async () => {
    const urls: string[] = [];
    const spy = async (url: string | URL | Request): Promise<Response> => {
      urls.push(String(url));
      return jsonRes(payload);
    };
    const empty = await fetchModelCatalogs([], { fetchFn: spy });
    expect(empty.providers.size).toBe(0);
    expect(empty.deprecatedIds.size).toBe(0);
    expect(urls).toHaveLength(0);

    await fetchModelCatalogs(["openai"], { fetchFn: spy });
    expect(urls).toEqual([MODELS_DEV_API_URL]);
  });

  it("maps HTTP errors, broken payloads and transport failures to friendly Chinese", async () => {
    await expect(fetchModelCatalogs(["a"], { fetchFn: async () => jsonRes({}, 503) })).rejects.toThrow(
      "接口返回 HTTP 503",
    );
    await expect(
      fetchModelCatalogs(["a"], { fetchFn: async () => new Response("not json", { status: 200 }) }),
    ).rejects.toThrow("接口返回了无法解析的内容");
    // AbortSignal.timeout rejects with a DOMException named "TimeoutError" — mirror that shape.
    const timeoutError = new Error("This operation was aborted");
    timeoutError.name = "TimeoutError";
    await expect(
      fetchModelCatalogs(["a"], {
        fetchFn: async () => {
          throw timeoutError;
        },
      }),
    ).rejects.toThrow(NETWORK_TIMEOUT_MESSAGE);
    await expect(
      fetchModelCatalogs(["a"], {
        fetchFn: async () => jsonRes([1, 2, 3]),
      }),
    ).rejects.toThrow("模型目录返回了无法解析的内容");
  });

  it("skips null provider entries and array-shaped models; duplicate provider ids collapse", async () => {
    const fetched = await fetchModelCatalogs(["nullish", "arraymodels", "openai", "openai"], {
      fetchFn: async () =>
        jsonRes({
          nullish: null,
          arraymodels: { id: "arraymodels", models: [{ id: "x" }] },
          openai: { id: "openai", models: { "gpt-5.6": { name: "", tool_call: true } } }, // empty name → fallback
        }),
    });
    expect(fetched.providers.size).toBe(1);
    expect(fetched.providers.get("openai")).toEqual([
      { id: "openai/gpt-5.6", provider: "openai", model: "gpt-5.6", label: "gpt-5.6" },
    ]);
  });
});

describe("mergeCatalogIntoLocal", () => {
  const local: ModelOption[] = [
    { id: "anthropic/claude-opus-4", provider: "anthropic", model: "claude-opus-4", label: "Claude Opus 4" },
    { id: "anthropic/claude-sonnet-5", provider: "anthropic", model: "claude-sonnet-5", label: "My custom label" },
    { id: "anthropic/claude-opus-4-1", provider: "anthropic", model: "claude-opus-4-1", label: "已弃用旧款" },
    { id: "deepseek/custom-tuned", provider: "deepseek", model: "custom-tuned", label: "自定义微调" },
  ];
  const fetched = new Map<string, ModelOption[]>([
    [
      "anthropic",
      [
        { id: "anthropic/claude-sonnet-5", provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "anthropic/claude-opus-5", provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
    ],
  ]);

  it("replaces same-id entries, appends new ids, keeps customs and prunes upstream-deprecated locals", () => {
    const { merged, addedIds, refreshedIds, prunedIds } = mergeCatalogIntoLocal(
      local,
      fetched,
      new Set(["anthropic/claude-opus-4-1"]),
    );
    const byId = new Map(merged.map((m) => [m.id, m]));
    expect(byId.get("anthropic/claude-sonnet-5")?.label).toBe("Claude Sonnet 5"); // fresh wins
    expect(byId.get("anthropic/claude-opus-5")?.label).toBe("Claude Opus 5"); // new upstream model
    expect(byId.has("anthropic/claude-opus-4")).toBe(true); // unknown upstream, still kept
    expect(byId.get("deepseek/custom-tuned")?.label).toBe("自定义微调"); // custom never dropped
    expect(byId.has("anthropic/claude-opus-4-1")).toBe(false); // deprecated pruned
    expect(merged).toHaveLength(4);
    expect(addedIds).toEqual(["anthropic/claude-opus-5"]);
    expect(refreshedIds).toEqual(["anthropic/claude-sonnet-5"]);
    expect(prunedIds).toEqual(["anthropic/claude-opus-4-1"]);
  });

  it("empty fetch changes nothing (no prune without deprecatedIds)", () => {
    const { merged, addedIds, refreshedIds, prunedIds } = mergeCatalogIntoLocal(local, new Map());
    expect(merged).toEqual(local);
    expect(addedIds).toEqual([]);
    expect(refreshedIds).toEqual([]);
    expect(prunedIds).toEqual([]);
  });
});

describe("updateLocalModelsFromCatalog", () => {
  it("merges the fetched provider into an existing local list, prunes deprecated ids and persists customs", () => {
    const dir = tmpDir();
    // A user-added custom model on a provider that the catalog will also return.
    addLocalModel(dir, { provider: "deepseek", model: "custom-tuned", label: "自定义微调" });
    // A stale entry models.dev now marks deprecated (legacy of the unfiltered era).
    addLocalModel(dir, { provider: "deepseek", model: "deepseek-v3", label: "DeepSeek V3" });

    const fetched = new Map<string, ModelOption[]>([
      [
        "deepseek",
        [
          {
            id: "deepseek/deepseek-v4-flash",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            label: "DeepSeek V4 Flash",
          },
          { id: "deepseek/deepseek-v5", provider: "deepseek", model: "deepseek-v5", label: "DeepSeek V5（新）" },
        ],
      ],
    ]);
    const result = updateLocalModelsFromCatalog(dir, fetched, new Set(["deepseek/deepseek-v3"]));
    expect(result.addedIds).toContain("deepseek/deepseek-v5");
    expect(result.prunedIds).toEqual(["deepseek/deepseek-v3"]);

    const persisted = ensureLocalModelsFile(dir);
    const byId = new Map(persisted.map((m) => [m.id, m]));
    expect(byId.get("deepseek/custom-tuned")?.label).toBe("自定义微调"); // custom survived
    expect(byId.has("deepseek/deepseek-v5")).toBe(true); // fresh model persisted
    expect(byId.has("deepseek/deepseek-v3")).toBe(false); // deprecated pruned
  });

  it("does not rewrite the file on a no-change update (identical content, JSONC hand edits survive)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "models.json");
    const handEdited = `{\n  // curated by hand\n  "models": [\n    { "provider": "deepseek", "model": "custom-tuned", "label": "自定义", },\n  ],\n}`;
    fs.writeFileSync(file, handEdited);
    // Re-fetching the SAME entry (identical provider/model/label) is not a change:
    // no rewrite, and the byte-identical file keeps its JSONC comments.
    const sameFetch = new Map<string, ModelOption[]>([
      ["deepseek", [{ id: "deepseek/custom-tuned", provider: "deepseek", model: "custom-tuned", label: "自定义" }]],
    ]);
    const result = updateLocalModelsFromCatalog(dir, sameFetch, new Set());
    expect(result.addedIds).toEqual([]);
    expect(result.refreshedIds).toEqual([]);
    expect(result.prunedIds).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(handEdited);

    // A truly empty fetch changes nothing either.
    updateLocalModelsFromCatalog(dir, new Map(), new Set());
    expect(fs.readFileSync(file, "utf8")).toBe(handEdited);
  });

  it("pruning the last local entry deletes models.json (absence = empty catalog)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "models.json");
    addLocalModel(dir, { provider: "deepseek", model: "deepseek-v3", label: "DeepSeek V3" });
    expect(fs.existsSync(file)).toBe(true);
    const result = updateLocalModelsFromCatalog(dir, new Map(), new Set(["deepseek/deepseek-v3"]));
    expect(result.prunedIds).toEqual(["deepseek/deepseek-v3"]);
    expect(fs.existsSync(file)).toBe(false);
    expect(ensureLocalModelsFile(dir)).toEqual([]);
  });
});

describe("seedLocalModelsFromCatalog", () => {
  const payload = {
    deepseek: {
      id: "deepseek",
      models: {
        "deepseek-v4": { name: "DeepSeek V4", tool_call: true },
        "deepseek-tts": { name: "DeepSeek TTS", tool_call: false },
        "deepseek-v3": { name: "DeepSeek V3", tool_call: true, status: "deprecated" },
      },
    },
    anthropic: { id: "anthropic", models: { "claude-opus-5": { name: "Claude Opus 5", tool_call: true } } },
    "not-curated": { id: "not-curated", models: { stray: { name: "Stray", tool_call: true } } },
  };
  const fetchFn = async (): Promise<Response> => jsonRes(payload);

  it("seeds an empty catalog from models.dev scoped to the builtin provider allowlist, unusable models filtered", async () => {
    const dir = tmpDir();
    const added = await seedLocalModelsFromCatalog(dir, { fetchFn });
    expect(new Set(added)).toEqual(new Set(["deepseek/deepseek-v4", "anthropic/claude-opus-5"]));
    const persisted = ensureLocalModelsFile(dir);
    const ids = persisted.map((m) => m.id);
    expect(ids).toContain("deepseek/deepseek-v4");
    expect(ids).toContain("anthropic/claude-opus-5");
    expect(ids.some((id) => id.startsWith("not-curated/"))).toBe(false); // allowlist filters
    expect(ids.some((id) => id.endsWith("-tts"))).toBe(false); // non-tool filtered
    expect(ids.some((id) => id.endsWith("-v3"))).toBe(false); // deprecated filtered
  });

  it("is a no-op (no fetch) when the local catalog is already populated", async () => {
    const dir = tmpDir();
    addLocalModel(dir, { provider: "p", model: "m" });
    const urls: string[] = [];
    const added = await seedLocalModelsFromCatalog(dir, {
      fetchFn: async (url) => {
        urls.push(String(url));
        return jsonRes(payload);
      },
    });
    expect(added).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it("rebuilds a corrupt local file (one-time .bak) from the network", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "models.json");
    const broken = "{ broken json";
    fs.writeFileSync(file, broken);
    const added = await seedLocalModelsFromCatalog(dir, { fetchFn });
    expect(added.length).toBeGreaterThan(0);
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(broken); // user bytes preserved
    expect(ensureLocalModelsFile(dir).length).toBeGreaterThan(0); // rebuilt
  });
});
