import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KNOWN_AGENTS as CORE_KNOWN_AGENTS,
  KNOWN_CATEGORIES as CORE_KNOWN_CATEGORIES,
  VARIANT_ORDER as CORE_VARIANT_ORDER,
  VARIANTS as CORE_VARIANTS,
} from "../../src/core/types";
import type { ModelOption as CoreModelOption } from "../../src/core/types";
import { KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANT_ORDER, VARIANTS } from "../../src/shared/protocol";
import type { ModelOption, Variant } from "../../src/shared/protocol";

const PROTOCOL_SRC = path.resolve(process.cwd(), "src/shared/protocol.ts");

describe("shared/protocol dependency guard", () => {
  it("protocol.ts declares no imports other than type-only from ./ (stays vscode-free and dependency-free)", () => {
    const source = readFileSync(PROTOCOL_SRC, "utf8");
    const importLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import"));
    // Currently zero imports; if one is ever needed it must be type-only, same-dir.
    for (const line of importLines) {
      expect(line).toMatch(/^import type \{[^}]*\} from "\.\/[^"]+";$/);
    }
    expect(source).not.toMatch(/["']vscode["']/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("evaluates standalone (no transitive runtime dependencies leaked through imports)", async () => {
    const mod = await import("../../src/shared/protocol");
    expect(mod.KNOWN_AGENTS.length).toBeGreaterThan(0);
  });
});

describe("shared/protocol canonical lists", () => {
  it("KNOWN_AGENTS / KNOWN_CATEGORIES are non-empty and duplicate-free", () => {
    for (const list of [KNOWN_AGENTS, KNOWN_CATEGORIES]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("VARIANT_ORDER is a permutation of VARIANTS (same five entries)", () => {
    expect([...VARIANT_ORDER].sort()).toEqual([...VARIANTS].sort());
    expect(new Set(VARIANT_ORDER).size).toBe(VARIANTS.length);
  });
});

describe("core/types re-exports the protocol canonicals (single source of truth)", () => {
  it("KNOWN_AGENTS / KNOWN_CATEGORIES / VARIANTS / VARIANT_ORDER are the same objects via both paths", () => {
    expect(CORE_KNOWN_AGENTS).toBe(KNOWN_AGENTS);
    expect(CORE_KNOWN_CATEGORIES).toBe(KNOWN_CATEGORIES);
    expect(CORE_VARIANTS).toBe(VARIANTS);
    expect(CORE_VARIANT_ORDER).toBe(VARIANT_ORDER);
  });

  it("ModelOption type is shared structurally (assignment compiles)", () => {
    const option: ModelOption = { id: "p/m", provider: "p", model: "m", label: "M" };
    const coreOption: CoreModelOption = option;
    expect(coreOption.id).toBe("p/m");
  });

  it("Variant values remain the classic five", () => {
    const variants: readonly Variant[] = ["low", "medium", "high", "xhigh", "max"];
    expect([...VARIANTS]).toEqual(variants);
  });
});
