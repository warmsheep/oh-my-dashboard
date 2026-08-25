import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readDirTree, TREE_EXCLUDES } from "../../src/core/skillScanner";

const sandboxes: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dirtree-"));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readDirTree host-protection hardening", () => {
  it("TREE_EXCLUDES prunes node_modules and .git from walks", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "skill-a", ".git", "objects", "ab"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skill-a", ".git", "objects", "ab", "loose-object"), "x");
    fs.mkdirSync(path.join(dir, "skill-a", "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skill-a", "node_modules", "dep", "index.js"), "x");
    fs.writeFileSync(path.join(dir, "skill-a", "SKILL.md"), "# a");

    const tree = readDirTree(dir, 0, TREE_EXCLUDES);
    const skill = tree.find((entry) => entry.name === "skill-a")!;
    expect(skill.children?.map((c) => c.name)).toEqual(["SKILL.md"]);
  });

  it("truncates the walk once the entry budget is exhausted", () => {
    const dir = tmpDir();
    for (let i = 0; i < 20; i += 1) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    }

    const tree = readDirTree(dir, 0, undefined, new Set(), { remaining: 5 });
    expect(tree.length).toBeLessThanOrEqual(5);
  });

  it("default budget bounds pathological trees (thousands of entries)", () => {
    const dir = tmpDir();
    const nested = path.join(dir, "repo", ".git", "objects");
    fs.mkdirSync(nested, { recursive: true });
    for (let i = 0; i < 3000; i += 1) {
      fs.writeFileSync(path.join(nested, `o${i}`), "x");
    }
    // .git is NOT excluded in this call (exclude omitted) — the budget must still cap it.
    const tree = readDirTree(dir);
    const count = (entries: typeof tree): number =>
      entries.reduce((n, entry) => n + 1 + (entry.children ? count(entry.children) : 0), 0);
    expect(count(tree)).toBeLessThanOrEqual(4000 + 2);
  });

  it("visited set keys on statSync identity: two symlinks to one dir walk it once", () => {
    const dir = tmpDir();
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "SKILL.md"), "#");
    fs.symlinkSync(real, path.join(dir, "link1"));
    fs.symlinkSync(real, path.join(dir, "link2"));

    const tree = readDirTree(dir);
    // link2's subtree dedupes to empty (visited hit on the shared target identity).
    const link1 = tree.find((entry) => entry.name === "link1")!;
    const link2 = tree.find((entry) => entry.name === "link2")!;
    expect(link1.children?.length).toBe(1);
    expect(link2.children).toBeUndefined();
  });
});
