import * as defaultFs from "node:fs";
import * as path from "node:path";
import * as realEditor from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";
import { assertContainedFileName, presetNameError } from "./pathSafety";
import type { ModelSetting, Preset } from "./types";
import type { ConfigStore } from "./configStore";
import type * as jsoncEditorModule from "./jsoncEditor";

export interface JsoncEditorApi {
  parseSafe: typeof jsoncEditorModule.parseSafe;
  getValue: typeof jsoncEditorModule.getValue;
  applyEdits: typeof jsoncEditorModule.applyEdits;
}

export interface PresetServiceOptions {
  presetsDir: string;
  configStore: ConfigStore;
  now?: () => Date;
  fs?: typeof import("node:fs");
  editor?: JsoncEditorApi;
  /** Defaults to process.platform; injectable for case-insensitive-FS rename tests. */
  platform?: NodeJS.Platform;
}

export interface ApplyChange {
  /** Basename of the file actually written (e.g. "omo.jsonc", "oh-my-opencode.json", "opencode.json"). */
  file: string;
  path: (string | number)[];
  from: unknown;
  to: unknown;
}

export interface ApplyResult {
  preset: import("./types").Preset;
  changes: ApplyChange[];
}

/** Sentinel reported as `to` in ApplyChange when a remove edit actually dropped a key. */
const REMOVED = "<<removed>>";

/** Reduce a raw assignment entry to { model, variant? }: drop null/undefined variants and any extra keys. */
function cleanSettings(record: Record<string, ModelSetting>): Record<string, ModelSetting> {
  const out: Record<string, ModelSetting> = {};
  for (const [key, setting] of Object.entries(record ?? {})) {
    const cleaned: ModelSetting = { model: setting.model };
    if (setting.variant != null) {
      cleaned.variant = setting.variant;
    }
    out[key] = cleaned;
  }
  return out;
}

function byName(a: Preset, b: Preset): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class PresetService {
  private readonly presetsDir: string;
  private readonly configStore: ConfigStore;
  private readonly now: () => Date;
  private readonly fs: typeof import("node:fs");
  private readonly editor: JsoncEditorApi;
  private readonly platform: NodeJS.Platform;

  constructor(opts: PresetServiceOptions) {
    this.presetsDir = opts.presetsDir;
    this.configStore = opts.configStore;
    this.now = opts.now ?? (() => new Date());
    this.fs = opts.fs ?? defaultFs;
    this.platform = opts.platform ?? process.platform;
    this.editor =
      opts.editor ?? {
        parseSafe: realEditor.parseSafe,
        getValue: realEditor.getValue,
        applyEdits: realEditor.applyEdits,
      };
  }

  private presetPath(name: string): string {
    // Traversal guard on every entry point: command args are arbitrary strings, and a
    // name containing separators or ".." would resolve outside presetsDir.
    assertContainedFileName(name, "INVALID_PRESET_NAME");
    return path.join(this.presetsDir, `${name}.json`);
  }

  list(): import("./types").Preset[] {
    if (!this.fs.existsSync(this.presetsDir)) {
      return [];
    }
    const presets: Preset[] = [];
    for (const entry of this.fs.readdirSync(this.presetsDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const text = this.fs.readFileSync(this.presetPath(entry.slice(0, -".json".length)), "utf8");
        presets.push(JSON.parse(text) as Preset);
      } catch {
        // Invalid entries are skipped silently.
      }
    }
    return presets.sort(byName);
  }

  load(name: string): import("./types").Preset {
    const file = this.presetPath(name);
    if (!this.fs.existsSync(file)) {
      throw new Error("PRESET_NOT_FOUND");
    }
    try {
      return JSON.parse(this.fs.readFileSync(file, "utf8")) as Preset;
    } catch {
      throw new Error("PRESET_INVALID");
    }
  }

  exists(name: string): boolean {
    return this.fs.existsSync(this.presetPath(name));
  }

  save(preset: import("./types").Preset): void {
    // Strict portability validation applies only when CREATING a new preset file;
    // re-saving an existing one (e.g. apply() stamping appliedAt on a preset named
    // under older, laxer rules) must keep working on the platform where it exists.
    if (!this.exists(preset.name) && presetNameError(preset.name) !== undefined) {
      throw new Error("INVALID_PRESET_NAME");
    }
    this.fs.mkdirSync(this.presetsDir, { recursive: true });
    this.configStore.writeAtomic(this.presetPath(preset.name), JSON.stringify(preset, null, 2) + "\n");
  }

  capture(name: string, description?: string): import("./types").Preset {
    const assignments = this.configStore.ohMyAssignments();
    const preset: Preset = {
      name,
      ...(description !== undefined ? { description } : {}),
      createdAt: this.now().toISOString(),
      appliedAt: null,
      defaults: { model: this.configStore.defaultModel() },
      agents: cleanSettings(assignments.agents),
      categories: cleanSettings(assignments.categories),
    };
    this.save(preset);
    return preset;
  }

  rename(oldName: string, newName: string): void {
    const preset = this.load(oldName);
    this.save({ ...preset, name: newName });
    const oldPath = this.presetPath(oldName);
    const newPath = this.presetPath(newName);
    // Case-insensitive filesystems (NTFS, default APFS, and ci mounts on Linux): a
    // case-only rename means both paths are the same file — rmSync would delete the
    // preset we just wrote. dev+ino identity is ground truth; the platform fold is
    // the fallback for filesystems that don't report stable inode numbers.
    let sameFile =
      this.platform === "linux" ? oldPath === newPath : oldPath.toLowerCase() === newPath.toLowerCase();
    try {
      const a = this.fs.statSync(oldPath);
      const b = this.fs.statSync(newPath);
      if (a.dev === b.dev && a.ino === b.ino) {
        sameFile = true;
      }
    } catch {
      // keep the platform heuristic
    }
    if (!sameFile) {
      // force: an external delete between load and here must not fail the rename —
      // the new preset is already saved and on-disk state is correct.
      this.fs.rmSync(oldPath, { force: true });
    }
  }

  remove(name: string): void {
    const file = this.presetPath(name);
    if (!this.fs.existsSync(file)) {
      throw new Error("PRESET_NOT_FOUND");
    }
    this.fs.rmSync(file);
  }

  exportTo(name: string, targetFile: string): void {
    const source = this.presetPath(name);
    if (!this.fs.existsSync(source)) {
      throw new Error("PRESET_NOT_FOUND");
    }
    this.configStore.writeAtomic(targetFile, this.fs.readFileSync(source, "utf8"));
  }

  apply(name: string): ApplyResult {
    const preset = this.load(name);
    const discovered = this.configStore.discover();
    const target = discovered.agentConfig;
    const changes: ApplyChange[] = [];

    // One edit batch for the agent config: for every listed key, set model, set-or-remove the
    // target's reasoning key, and drop the deprecated sibling key plus any `models` chain —
    // otherwise the preset's single-model assignment would silently lose to them. Keys NOT
    // present in the preset are never touched.
    const edits: JsoncEdit[] = [];
    const otherReasoningKey = target.reasoningKey === "reasoning" ? "variant" : "reasoning";
    const collect = (section: "agents" | "categories", settings: Record<string, ModelSetting>): void => {
      for (const [key, setting] of Object.entries(settings)) {
        const base = [...target.sectionPath, section, key];
        edits.push({ path: [...base, "model"], value: setting.model, op: "set" });
        if (setting.variant != null) {
          edits.push({ path: [...base, target.reasoningKey], value: setting.variant, op: "set" });
        } else {
          edits.push({ path: [...base, target.reasoningKey], value: undefined, op: "remove" });
        }
        edits.push({ path: [...base, otherReasoningKey], value: undefined, op: "remove" });
        edits.push({ path: [...base, "models"], value: undefined, op: "remove" });
      }
    };
    collect("agents", preset.agents);
    collect("categories", preset.categories);

    const agentText = this.configStore.readTextForEdit(target.path);
    const agentParse = this.editor.parseSafe<unknown>(agentText);
    if (agentParse.errors.length > 0) {
      // Never touch a broken file.
      throw new realEditor.JsoncSyntaxError(agentParse.errors);
    }

    // Pre-flight BOTH files before any write: a syntax-broken opencode.json must not
    // leave the agent config modified while the apply errors out (mixed state).
    const opencodePath = discovered.opencodeJson;
    const opencodeText = this.configStore.readTextForEdit(opencodePath);
    const opencodeParse = this.editor.parseSafe<unknown>(opencodeText);
    if (opencodeParse.errors.length > 0) {
      throw new realEditor.JsoncSyntaxError(opencodeParse.errors);
    }

    const recordChanges = (file: string, fileEdits: JsoncEdit[], text: string): void => {
      for (const edit of fileEdits) {
        const from = this.editor.getValue(text, edit.path);
        const isRemove = (edit.op ?? "set") === "remove";
        if (isRemove ? from !== undefined : from !== edit.value) {
          changes.push({ file, path: edit.path, from, to: isRemove ? REMOVED : edit.value });
        }
      }
    };
    recordChanges(path.basename(target.path), edits, agentText);

    const newAgentText = this.editor.applyEdits(agentText.length > 0 ? agentText : "{}", edits);
    if (newAgentText !== agentText) {
      this.fs.mkdirSync(path.dirname(target.path), { recursive: true });
      this.configStore.writeAtomic(target.path, newAgentText);
    }

    const model = preset.defaults?.model ?? null;
    const modelEdit: JsoncEdit =
      model != null
        ? { path: ["model"], value: model, op: "set" }
        : { path: ["model"], value: undefined, op: "remove" };
    recordChanges(path.basename(opencodePath), [modelEdit], opencodeText);
    const newOpencodeText = this.editor.applyEdits(opencodeText, [modelEdit]);
    if (newOpencodeText !== opencodeText) {
      this.configStore.writeAtomic(opencodePath, newOpencodeText);
    }

    preset.appliedAt = this.now().toISOString();
    this.save(preset);
    return { preset, changes };
  }

  currentPresetName(): string | null {
    let best: { name: string; appliedAt: string } | null = null;
    for (const preset of this.list()) {
      if (typeof preset.appliedAt !== "string") {
        continue;
      }
      if (best === null || preset.appliedAt > best.appliedAt) {
        best = { name: preset.name, appliedAt: preset.appliedAt };
      }
    }
    return best === null ? null : best.name;
  }
}
