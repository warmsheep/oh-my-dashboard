import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { agentAssignmentEdits } from "../../src/core/agentAssignment";

describe("agentAssignmentEdits (shared assignment edit builder)", () => {
  it("builds the canonical 4-edit list: model set, reasoning set, sibling key removed, models chain removed", () => {
    expect(agentAssignmentEdits(["[opencode]"], "reasoning", "agents", "oracle", "x/y", "max")).toEqual([
      { path: ["[opencode]", "agents", "oracle", "model"], value: "x/y", op: "set" },
      { path: ["[opencode]", "agents", "oracle", "reasoning"], value: "max", op: "set" },
      { path: ["[opencode]", "agents", "oracle", "variant"], value: undefined, op: "remove" },
      { path: ["[opencode]", "agents", "oracle", "models"], value: undefined, op: "remove" },
    ]);
  });

  it("null variant REMOVES the reasoning key; legacy target flips to variant/reasoning", () => {
    expect(agentAssignmentEdits([], "variant", "categories", "quick", "a/b", null)).toEqual([
      { path: ["categories", "quick", "model"], value: "a/b", op: "set" },
      { path: ["categories", "quick", "variant"], value: undefined, op: "remove" },
      { path: ["categories", "quick", "reasoning"], value: undefined, op: "remove" },
      { path: ["categories", "quick", "models"], value: undefined, op: "remove" },
    ]);
  });
});

describe("agentAssignment module layout guard", () => {
  it("presetService keeps only type-only imports of configStore (agentAssignment is the shared leaf)", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/core/presetService.ts"), "utf8");
    const importLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import") && line.includes("./configStore"));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/^import type \{/);
    }
  });
});
