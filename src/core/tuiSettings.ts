import { TUI_THEME_MAX_LENGTH } from "../shared/protocol";
import { getValue } from "./jsoncEditor";
import type { JsoncEdit } from "./jsoncEditor";

/**
 * Read the `theme` string from a tui.json text (display-tolerant: absent key,
 * unparsable text and non-string values all read as null).
 */
export function readTuiTheme(text: string): string | null {
  const theme = getValue<unknown>(text, ["theme"]);
  return typeof theme === "string" ? theme : null;
}

/**
 * The single set-or-remove edit for tui.json's `theme` key (null → remove op).
 * Pure edit builder — value validation lives in {@link isValidTuiTheme} and is
 * enforced by the caller (ConfigStore.setTuiTheme).
 */
export function tuiThemeEdits(theme: string | null): JsoncEdit[] {
  return [
    theme === null ? { path: ["theme"], value: undefined, op: "remove" } : { path: ["theme"], value: theme, op: "set" },
  ];
}

/** Host-side theme validator: a trimmed non-empty string of at most {@link TUI_THEME_MAX_LENGTH} chars. */
export function isValidTuiTheme(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= TUI_THEME_MAX_LENGTH;
}
