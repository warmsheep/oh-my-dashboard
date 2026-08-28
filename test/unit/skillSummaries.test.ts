import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSkillDescription, skillSummaries } from "../../src/core/skillScanner";
import type { SkillLocation } from "../../src/core/types";

const sandboxes: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  sandboxes.push(dir);
  return dir;
}

/** Seed <dir>/<name>/SKILL.md with the given content; content omitted = dir without SKILL.md. */
function seedSkill(dir: string, name: string, content?: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  if (content !== undefined) {
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
  }
  return skillDir;
}

/** Minimal SkillLocation double — skillSummaries only reads scope/label/dir/skillNames. */
function location(scope: "global" | "project", label: string, dir: string, skillNames: string[]): SkillLocation {
  return { scope, label, dir, skillNames, tree: [] };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readSkillDescription", () => {
  it("reads a bare single-line description from the leading frontmatter block", () => {
    const dir = seedSkill(
      tmpDir(),
      "bare",
      "---\nname: bare\ndescription: Use this skill for testing\n---\n\n# body\n",
    );
    expect(readSkillDescription(dir)).toBe("Use this skill for testing");
  });

  it("strips double quotes around the value", () => {
    const dir = seedSkill(tmpDir(), "dq", '---\ndescription: "quoted value"\n---\n');
    expect(readSkillDescription(dir)).toBe("quoted value");
  });

  it("strips single quotes around the value", () => {
    const dir = seedSkill(tmpDir(), "sq", "---\ndescription: 'single quoted'\n---\n");
    expect(readSkillDescription(dir)).toBe("single quoted");
  });

  it('returns "" when the frontmatter has no description key', () => {
    const dir = seedSkill(tmpDir(), "nodesc", "---\nname: nodesc\n---\n\n# body\n");
    expect(readSkillDescription(dir)).toBe("");
  });

  it('returns "" for a file without frontmatter', () => {
    const dir = seedSkill(tmpDir(), "nofm", "# plain markdown\ndescription: body text\n");
    expect(readSkillDescription(dir)).toBe("");
  });

  it('returns "" when SKILL.md is missing', () => {
    const dir = seedSkill(tmpDir(), "empty");
    expect(readSkillDescription(dir)).toBe("");
  });

  it("ignores description occurrences outside the leading block and nested keys", () => {
    const dir = seedSkill(
      tmpDir(),
      "outside",
      "---\nname: outside\nmetadata:\n  description: nested\n---\ndescription: body line\n",
    );
    expect(readSkillDescription(dir)).toBe("");
  });

  it("caps the value at 300 chars and appends the ellipsis mark", () => {
    const long = "x".repeat(400);
    const dir = seedSkill(tmpDir(), "long", `---\ndescription: ${long}\n---\n`);
    expect(readSkillDescription(dir)).toBe(`${"x".repeat(300)}…`);
  });

  it("parses CRLF files", () => {
    const dir = seedSkill(tmpDir(), "crlf", "---\r\ndescription: crlf value\r\n---\r\n");
    expect(readSkillDescription(dir)).toBe("crlf value");
  });

  it('returns "" for BOM-prefixed files (the leading fence is no longer the first line)', () => {
    const dir = seedSkill(tmpDir(), "bom", "\uFEFF---\ndescription: bom value\n---\n");
    expect(readSkillDescription(dir)).toBe("");
  });

  it("takes the remainder of the line for multi-line folded styles (documented limitation)", () => {
    const dir = seedSkill(tmpDir(), "folded", "---\ndescription: >-\n  folded body\n---\n");
    expect(readSkillDescription(dir)).toBe(">-");
  });

  it("collapses inner whitespace runs", () => {
    const dir = seedSkill(tmpDir(), "ws", "---\ndescription:   spaced \t out   value  \n---\n");
    expect(readSkillDescription(dir)).toBe("spaced out value");
  });

  it("reads at most the first 8 KiB (a late fence beyond the cap is never seen)", () => {
    const dir = seedSkill(
      tmpDir(),
      "capped",
      `---\nname: capped\n${"#".repeat(9 * 1024)}\n---\ndescription: never reached\n`,
    );
    expect(readSkillDescription(dir)).toBe("");
  });
});

describe("skillSummaries", () => {
  it("maps every location × skill with description, scope and location label", () => {
    const root = tmpDir();
    seedSkill(root, "alpha", "---\ndescription: first skill\n---\n");
    seedSkill(root, "beta", "---\ndescription: second skill\n---\n");
    const summaries = skillSummaries([location("global", "~/.agents/skills", root, ["alpha", "beta"])]);
    expect(summaries).toEqual([
      { name: "alpha", description: "first skill", scope: "global", locationLabel: "~/.agents/skills" },
      { name: "beta", description: "second skill", scope: "global", locationLabel: "~/.agents/skills" },
    ]);
  });

  it("sorts by locationLabel then name across multiple locations", () => {
    const rootA = tmpDir();
    const rootB = tmpDir();
    seedSkill(rootA, "zeta", "---\ndescription: z\n---\n");
    seedSkill(rootA, "alpha", "---\ndescription: a\n---\n");
    seedSkill(rootB, "mid", "---\ndescription: m\n---\n");
    const summaries = skillSummaries([
      location("global", "~/.config/opencode/skills", rootA, ["zeta", "alpha"]),
      location("project", ".claude/skills", rootB, ["mid"]),
    ]);
    // localeCompare: "." sorts before "~", so the project label group comes first.
    expect(summaries.map((s) => `${s.locationLabel}:${s.name}`)).toEqual([
      ".claude/skills:mid",
      "~/.config/opencode/skills:alpha",
      "~/.config/opencode/skills:zeta",
    ]);
  });

  it("carries project and global scopes through mixed locations", () => {
    const global = tmpDir();
    const project = tmpDir();
    seedSkill(global, "gskill", "---\ndescription: g\n---\n");
    seedSkill(project, "pskill", "# no frontmatter\n");
    const summaries = skillSummaries([
      location("global", "~/.agents/skills", global, ["gskill"]),
      location("project", ".claude/skills", project, ["pskill"]),
    ]);
    expect(summaries.map((s) => `${s.name}:${s.scope}`)).toEqual(["pskill:project", "gskill:global"]);
    expect(summaries[0].description).toBe("");
    expect(summaries[1].description).toBe("g");
  });

  it("returns [] for empty locations", () => {
    expect(skillSummaries([])).toEqual([]);
  });
});
