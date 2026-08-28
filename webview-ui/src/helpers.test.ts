import type { PresetRow } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import {
  countConfigured,
  formatPresetDate,
  groupModelsByProvider,
  isDirty,
  isDirtyRisingEdge,
  isKnownVariant,
  mergeRows,
  setAllModels,
  variantFromLabel,
  variantLabel,
  type FormState,
  type ModelOption,
} from "./helpers";

const row = (
  section: PresetRow["section"],
  name: string,
  model: string | null,
  variant: PresetRow["variant"] = null,
): PresetRow => ({ section, name, model, variant });

const model = (id: string, provider: string, label = id): ModelOption => ({
  id,
  provider,
  model: id.split("/")[1] ?? id,
  label,
});

const form = (over: Partial<FormState> = {}): FormState => ({
  name: "p",
  description: "",
  rows: [],
  ...over,
});

describe("setAllModels", () => {
  it("sets the model on every row that already has a model configured", () => {
    const rows = [row("agents", "oracle", "old/a"), row("categories", "quick", "old/b")];
    const next = setAllModels(rows, "new/x");
    expect(next.map((r) => r.model)).toEqual(["new/x", "new/x"]);
  });

  it('fills placeholder rows too: "全部模型设为" covers rows the preset never configured (e.g. newly added agents)', () => {
    const rows = [
      row("agents", "oracle", null),
      row("agents", "sisyphus-junior", null),
      row("agents", "momus", "old/a"),
    ];
    const next = setAllModels(rows, "new/x");
    expect(next.map((r) => r.model)).toEqual(["new/x", "new/x", "new/x"]);
  });

  it("returns a new array and new row objects without mutating the input", () => {
    const rows = [row("agents", "oracle", "a/1", "high")];
    const next = setAllModels(rows, "b/2");
    expect(next).not.toBe(rows);
    expect(next[0]).not.toBe(rows[0]);
    expect(rows[0].model).toBe("a/1");
  });

  it("preserves section, name and variant of every row", () => {
    const rows = [row("categories", "deep", "a/1", "xhigh")];
    const next = setAllModels(rows, "b/2");
    expect(next[0]).toMatchObject({
      section: "categories",
      name: "deep",
      variant: "xhigh",
    });
  });
});

describe("mergeRows", () => {
  it("lists known names first (in known-list order), then extras alphabetically", () => {
    const current = [
      row("agents", "zeta", "m/1"),
      row("agents", "oracle", "m/2"),
      row("agents", "alpha", null),
      row("agents", "momus", "m/3"),
    ];
    const next = mergeRows(["hephaestus", "oracle", "momus"], current, "agents");
    expect(next.map((r) => r.name)).toEqual(["hephaestus", "oracle", "momus", "alpha", "zeta"]);
  });

  it("keeps the existing model/variant values of rows present in current", () => {
    const current = [row("agents", "oracle", "m/2", "low")];
    const next = mergeRows(["hephaestus", "oracle"], current, "agents");
    expect(next[1]).toEqual(row("agents", "oracle", "m/2", "low"));
  });

  it("creates placeholder rows (model/variant null) for known names missing from current", () => {
    const next = mergeRows(["oracle", "metis"], [], "agents");
    expect(next).toEqual([row("agents", "oracle", null), row("agents", "metis", null)]);
  });

  it("only merges rows of the requested section and tags placeholders with that section", () => {
    const current = [row("categories", "quick", "m/1"), row("agents", "oracle", "m/2")];
    const next = mergeRows(["quick"], current, "categories");
    expect(next).toEqual([row("categories", "quick", "m/1")]);
  });

  it("is stable for an empty current list: all known names in order, all null", () => {
    const known = ["b", "a", "c"];
    expect(mergeRows(known, [], "categories")).toEqual([
      row("categories", "b", null),
      row("categories", "a", null),
      row("categories", "c", null),
    ]);
  });
});

describe("isDirty", () => {
  it("returns false for identical states", () => {
    const state = form({
      name: "daily",
      description: "d",
      rows: [row("agents", "oracle", "m/1", "high")],
    });
    expect(isDirty(state, { ...state, rows: [{ ...state.rows[0] }] })).toBe(false);
  });

  it("detects a name change", () => {
    expect(isDirty(form({ name: "a" }), form({ name: "b" }))).toBe(true);
  });

  it("detects a description change", () => {
    expect(isDirty(form({ description: "" }), form({ description: "x" }))).toBe(true);
  });

  it("detects deep row changes: model, variant and name", () => {
    const rows = [row("agents", "oracle", "m/1", "low")];
    expect(isDirty(form({ rows }), form({ rows: [row("agents", "oracle", "m/2", "low")] }))).toBe(true);
    expect(isDirty(form({ rows }), form({ rows: [row("agents", "oracle", "m/1", "max")] }))).toBe(true);
    expect(isDirty(form({ rows }), form({ rows: [row("agents", "renamed", "m/1", "low")] }))).toBe(true);
  });

  it("treats null vs value model/variant as different", () => {
    expect(
      isDirty(form({ rows: [row("agents", "oracle", null)] }), form({ rows: [row("agents", "oracle", "m/1", null)] })),
    ).toBe(true);
  });

  it("detects a row count change", () => {
    expect(
      isDirty(
        form({ rows: [row("agents", "oracle", "m/1")] }),
        form({
          rows: [row("agents", "oracle", "m/1"), row("agents", "metis", null)],
        }),
      ),
    ).toBe(true);
  });

  it("is order-sensitive by design: row order comes from mergeRows, so a reorder counts as dirty", () => {
    const a = form({
      rows: [row("agents", "a", null), row("agents", "b", null)],
    });
    const b = form({
      rows: [row("agents", "b", null), row("agents", "a", null)],
    });
    expect(isDirty(a, b)).toBe(true);
  });
});

describe("variantLabel ↔ variantFromLabel ('' ↔ null mapping)", () => {
  it("maps null to '' and each variant to itself", () => {
    expect(variantLabel(null)).toBe("");
    expect(variantLabel("low")).toBe("low");
    expect(variantLabel("medium")).toBe("medium");
    expect(variantLabel("high")).toBe("high");
    expect(variantLabel("xhigh")).toBe("xhigh");
    expect(variantLabel("max")).toBe("max");
  });

  it("maps '' back to null and any variant string back to the variant", () => {
    expect(variantFromLabel("")).toBeNull();
    expect(variantFromLabel("low")).toBe("low");
    expect(variantFromLabel("max")).toBe("max");
  });

  it("round-trips for the full variant set", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(variantFromLabel(variantLabel(v))).toBe(v);
    }
    expect(variantFromLabel(variantLabel(null))).toBeNull();
  });
});

describe("isDirtyRisingEdge (host is notified only on false→true)", () => {
  it("fires only on the false→true transition", () => {
    expect(isDirtyRisingEdge(true, false)).toBe(true);
  });

  it("stays silent while dirty stays true (no per-keystroke messages)", () => {
    expect(isDirtyRisingEdge(true, true)).toBe(false);
  });

  it("stays silent on falling and steady-false edges (host ignores dirty:false)", () => {
    expect(isDirtyRisingEdge(false, true)).toBe(false);
    expect(isDirtyRisingEdge(false, false)).toBe(false);
  });
});

describe("isKnownVariant (classic five membership, wide-string safe)", () => {
  it("accepts the classic five and rejects harness-native tokens", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"]) {
      expect(isKnownVariant(v)).toBe(true);
    }
    expect(isKnownVariant("off")).toBe(false);
    expect(isKnownVariant("minimal")).toBe(false);
  });
});

describe("countConfigured", () => {
  it("counts only rows with a non-null model: 0 / partial / all", () => {
    expect(countConfigured([])).toBe(0);
    expect(countConfigured([row("agents", "oracle", null), row("categories", "quick", null)])).toBe(0);
    expect(
      countConfigured([row("agents", "oracle", "a/1"), row("agents", "momus", null), row("categories", "deep", "b/2")]),
    ).toBe(2);
    expect(countConfigured([row("agents", "oracle", "a/1"), row("categories", "quick", "b/2", "high")])).toBe(2);
  });
});

describe("groupModelsByProvider", () => {
  it("groups models by provider preserving first-appearance order of providers", () => {
    const groups = groupModelsByProvider([
      model("zhipu/glm-4.7", "zhipu", "GLM 4.7"),
      model("anthropic/claude-sonnet-4.5", "anthropic", "Claude Sonnet 4.5"),
      model("zhipu/glm-4.5-air", "zhipu", "GLM 4.5 Air"),
      model("google/gemini-2.5-pro", "google", "Gemini 2.5 Pro"),
    ]);
    expect([...groups.keys()]).toEqual(["zhipu", "anthropic", "google"]);
    expect(groups.get("zhipu")?.map((m) => m.id)).toEqual(["zhipu/glm-4.7", "zhipu/glm-4.5-air"]);
    expect(groups.get("anthropic")?.[0].label).toBe("Claude Sonnet 4.5");
  });

  it("returns an empty map for no models", () => {
    expect(groupModelsByProvider([]).size).toBe(0);
  });
});

describe("formatPresetDate", () => {
  it("formats an ISO timestamp as a zero-padded local YYYY-MM-DD date", () => {
    const date = new Date(2026, 7, 28, 9, 30);
    expect(formatPresetDate(date.toISOString())).toBe("2026-08-28");
  });

  it("pads single-digit months and days", () => {
    const date = new Date(2026, 0, 5, 0, 0);
    expect(formatPresetDate(date.toISOString())).toBe("2026-01-05");
  });

  it("degrades null and empty strings to the em dash", () => {
    expect(formatPresetDate(null)).toBe("—");
    expect(formatPresetDate("")).toBe("—");
  });

  it("degrades garbage input instead of rendering Invalid Date", () => {
    expect(formatPresetDate("not-a-date")).toBe("—");
  });
});
