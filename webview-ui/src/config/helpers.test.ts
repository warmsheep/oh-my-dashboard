import type { PresetRow, SkillSummary } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import { groupSkillsByLocation, skillDescriptionLabel, skillScopeLabel, upsertRow } from "./helpers";

function skill(name: string, locationLabel: string, scope: SkillSummary["scope"] = "global"): SkillSummary {
  return { name, description: "", scope, locationLabel };
}

describe("groupSkillsByLocation", () => {
  it("groups by location label preserving first-appearance order of groups and skills", () => {
    const groups = groupSkillsByLocation([
      skill("alpha", "~/.agents/skills"),
      skill("beta", ".claude/skills", "project"),
      skill("gamma", "~/.agents/skills"),
    ]);
    expect(groups.map((g) => g.locationLabel)).toEqual(["~/.agents/skills", ".claude/skills"]);
    expect(groups[0]?.skills.map((s) => s.name)).toEqual(["alpha", "gamma"]);
    expect(groups[1]?.skills.map((s) => s.name)).toEqual(["beta"]);
  });

  it("takes the group scope from its first entry", () => {
    const groups = groupSkillsByLocation([skill("a", "x", "project"), skill("b", "x", "global")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.scope).toBe("project");
  });

  it("returns an empty array when there are no skills", () => {
    expect(groupSkillsByLocation([])).toEqual([]);
  });
});

describe("skillScopeLabel", () => {
  it("maps scopes to Chinese labels", () => {
    expect(skillScopeLabel("global")).toBe("全局");
    expect(skillScopeLabel("project")).toBe("项目");
  });
});

describe("skillDescriptionLabel", () => {
  it("passes through a real description", () => {
    expect(skillDescriptionLabel("审查代码")).toBe("审查代码");
  });

  it("degrades empty and whitespace-only descriptions to the placeholder", () => {
    expect(skillDescriptionLabel("")).toBe("无描述");
    expect(skillDescriptionLabel("   ")).toBe("无描述");
  });
});

describe("upsertRow", () => {
  const rows: PresetRow[] = [
    { section: "agents", name: "oracle", model: "a/b", variant: "high" },
    { section: "categories", name: "quick", model: null, variant: null },
  ];

  it("patches an existing row in place", () => {
    expect(upsertRow(rows, "agents", "oracle", { model: "c/d", variant: "low" })).toEqual([
      { section: "agents", name: "oracle", model: "c/d", variant: "low" },
      { section: "categories", name: "quick", model: null, variant: null },
    ]);
  });

  it("matches rows by section AND name (a same-named row in the other section is untouched)", () => {
    const dup: PresetRow[] = [
      { section: "agents", name: "quick", model: null, variant: null },
      { section: "categories", name: "quick", model: null, variant: null },
    ];
    const next = upsertRow(dup, "categories", "quick", { model: "c/d", variant: null });
    expect(next[0]).toEqual({ section: "agents", name: "quick", model: null, variant: null });
    expect(next[1]).toEqual({ section: "categories", name: "quick", model: "c/d", variant: null });
  });

  it("appends a full row when the section+name is absent (host may send configured rows only)", () => {
    const next = upsertRow(rows, "agents", "explore", { model: "e/f", variant: null });
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ section: "agents", name: "explore", model: "e/f", variant: null });
  });

  it("does not mutate the input array", () => {
    const before = rows.map((r) => ({ ...r }));
    upsertRow(rows, "agents", "oracle", { model: "x/y", variant: "max" });
    expect(rows).toEqual(before);
  });
});
