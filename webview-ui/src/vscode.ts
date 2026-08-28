import type { WebviewToExt } from "@shared/protocol";

import type { FormState } from "./helpers";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

let cached: VSCodeApi | undefined;

export function hasVSCodeApi(): boolean {
  return typeof acquireVsCodeApi === "function";
}

/**
 * acquireVsCodeApi exists only inside a real webview; in a plain browser
 * (vite dev) fall back to window messages + in-memory state so neither the
 * build nor browser preview crashes.
 */
export function getVSCodeApi(): VSCodeApi {
  if (cached) return cached;
  if (hasVSCodeApi()) {
    cached = acquireVsCodeApi();
  } else {
    const store: { value: unknown } = { value: undefined };
    cached = {
      postMessage: (message) => window.postMessage(message, window.location.origin),
      getState: <T>() => store.value as T | undefined,
      setState: <T>(state: T) => {
        store.value = state;
      },
    };
  }
  return cached;
}

export function postToHost(message: WebviewToExt): void {
  getVSCodeApi().postMessage(message);
}

/**
 * Whole-webview state shape. The manager page is ONE webview hosting three tabs,
 * so the previously per-page getState slots are namespaced: the active tab and
 * per-preset editor drafts (keyed by the preset name the draft belongs to) must
 * not clobber each other — every writer merges into the current state object.
 */
export interface ManagerWebviewState {
  managerTab?: unknown;
  presetDrafts?: Record<string, FormState>;
}

function readState(): ManagerWebviewState {
  try {
    const state = getVSCodeApi().getState<ManagerWebviewState>();
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function writeState(next: ManagerWebviewState): void {
  try {
    getVSCodeApi().setState(next);
  } catch {
    /* persisting state is best-effort */
  }
}

/** Persist the active manager tab while preserving the preset drafts. */
export function setManagerTabState(tab: string): void {
  writeState({ ...readState(), managerTab: tab });
}

/** Load the unsaved editor draft for ONE preset (keyed by its original open name). */
export function loadPresetDraft(origName: string): FormState | undefined {
  const draft = readState().presetDrafts?.[origName];
  return draft && typeof draft === "object" && Array.isArray(draft.rows) ? draft : undefined;
}

export function savePresetDraft(origName: string, form: FormState): void {
  const current = readState();
  writeState({ ...current, presetDrafts: { ...current.presetDrafts, [origName]: form } });
}

export function clearPresetDraft(origName: string): void {
  const current = readState();
  if (current.presetDrafts === undefined || !(origName in current.presetDrafts)) {
    return;
  }
  const drafts = { ...current.presetDrafts };
  delete drafts[origName];
  writeState({ ...current, presetDrafts: drafts });
}
