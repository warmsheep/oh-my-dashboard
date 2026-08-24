import {
  applyEdits as applyJsoncEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parse,
  parseTree,
} from "jsonc-parser";

import type { JsoncError, JsonPath, ParseResult } from "./types";

export interface JsoncEdit {
  path: JsonPath;
  value: unknown;
  op?: "set" | "remove";
}

export class JsoncSyntaxError extends Error {
  constructor(public readonly errors: JsoncError[]) {
    super(`JSONC syntax errors: ${errors.length}`);
    this.name = "JsoncSyntaxError";
  }
}

const PARSE_OPTIONS = { allowTrailingComma: true, allowEmptyContent: true } as const;

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true };

/**
 * Strip leading UTF-8 BOMs: readFileSync(path, "utf8") keeps them and jsonc-parser
 * reports each BOM itself as a syntax error even when the rest of the file is valid.
 * ALL leading BOMs are stripped — script/PowerShell concatenation can produce doubles.
 */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF+/, "");
}

function toErrors(errors: { offset: number; length: number; error: number }[]): JsoncError[] {
  // User-visible (tree nodes render it verbatim) — keep it Chinese.
  return errors.map((e) => ({ offset: e.offset, length: e.length, message: `语法错误（错误码 ${e.error}）` }));
}

export function parseSafe<T>(text: string): ParseResult<T> {
  const errors: { offset: number; length: number; error: number }[] = [];
  const value = parse(stripBom(text), errors, PARSE_OPTIONS) as T | undefined;
  return { value: value === undefined ? null : value, errors: toErrors(errors) };
}

export function validate(text: string): JsoncError[] {
  return parseSafe<unknown>(text).errors;
}

export function getValue<T>(text: string, path: JsonPath): T | undefined {
  const root = parseTree(text, undefined, PARSE_OPTIONS);
  const node = root ? findNodeAtLocation(root, path) : undefined;
  return node ? (getNodeValue(node) as T) : undefined;
}

function assertParsable(text: string): void {
  const errors = validate(text);
  if (errors.length > 0) {
    throw new JsoncSyntaxError(errors);
  }
}

function hasPath(text: string, path: JsonPath): boolean {
  const root = parseTree(text, undefined, PARSE_OPTIONS);
  return root !== undefined && findNodeAtLocation(root, path) !== undefined;
}

export function applyEdits(text: string, edits: JsoncEdit[]): string {
  // Edit the BOM-stripped body so offsets stay aligned, then re-attach the original
  // BOM prefix (however many) — a "UTF-8 with BOM" file must not silently lose it.
  const bom = text.match(/^\uFEFF+/)?.[0] ?? "";
  let current = bom ? text.slice(bom.length) : text;
  assertParsable(current);
  for (const edit of edits) {
    const isRemove = (edit.op ?? "set") === "remove";
    if (isRemove && !hasPath(current, edit.path)) {
      continue;
    }
    const value = isRemove ? undefined : edit.value;
    const modifications = modify(current, edit.path, value, { formattingOptions: FORMATTING_OPTIONS });
    current = applyJsoncEdits(current, modifications);
  }
  return bom + current;
}

export function setValues(text: string, entries: { path: JsonPath; value: unknown }[]): string {
  return applyEdits(
    text,
    entries.map((entry) => ({ path: entry.path, value: entry.value, op: "set" as const })),
  );
}

export function removeKey(text: string, path: JsonPath): string {
  return applyEdits(text, [{ path, value: undefined, op: "remove" }]);
}
