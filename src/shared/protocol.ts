import type { ModelOption } from "../core/types";

export interface PresetRow {
  section: "agents" | "categories";
  name: string;
  model: string | null;
  /** Reasoning level; wider than the classic five variants (omo accepts "off"/"minimal"/...). */
  variant: string | null;
}

export interface WebviewInitPayload {
  preset: { name: string; description?: string; rows: PresetRow[] };
  models: ModelOption[];
}

export type ExtToWebview =
  | { type: "init"; payload: WebviewInitPayload }
  | { type: "modelsUpdated"; payload: { models: ModelOption[] } }
  | { type: "result"; payload: { action: "save" | "apply"; ok: boolean; error?: string } };

export type WebviewToExt =
  | { type: "ready" }
  | { type: "dirty"; payload: boolean }
  | { type: "cancel" }
  | { type: "save"; payload: { name: string; description?: string; rows: PresetRow[]; apply: boolean } };
