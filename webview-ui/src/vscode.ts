import type { PresetRow, WebviewToExt } from "@shared/protocol";
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
      postMessage: (message) =>
        window.postMessage(message, window.location.origin),
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

export interface DraftState {
  origName: string;
  form: FormState;
}

export function loadDraft(): DraftState | undefined {
  try {
    const d = getVSCodeApi().getState<DraftState>();
    return d &&
      typeof d === "object" &&
      typeof d.origName === "string" &&
      Array.isArray(d.form?.rows)
      ? d
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveDraft(draft: DraftState): void {
  try {
    getVSCodeApi().setState(draft);
  } catch {
    /* persisting a draft is best-effort */
  }
}

export function clearDraft(rows: PresetRow[]): void {
  saveDraft({ origName: "", form: { name: "", description: "", rows } });
}
