import { parse, parseTree, findNodeAtLocation, getNodeValue } from "jsonc-parser";
import type { JsonPath, JsoncError, ParseResult } from "./types";

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

function toErrors(errors: { offset: number; length: number; error: number }[]): JsoncError[] {
  return errors.map((e) => ({ offset: e.offset, length: e.length, message: `Parse error code ${e.error}` }));
}

export function parseSafe<T>(text: string): ParseResult<T> {
  const errors: { offset: number; length: number; error: number }[] = [];
  const value = parse(text, errors, PARSE_OPTIONS) as T | undefined;
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

export function applyEdits(_text: string, _edits: JsoncEdit[]): string {
  throw new Error("NOT_IMPLEMENTED");
}

export function setValues(_text: string, _entries: { path: JsonPath; value: unknown }[]): string {
  throw new Error("NOT_IMPLEMENTED");
}

export function removeKey(_text: string, _path: JsonPath): string {
  throw new Error("NOT_IMPLEMENTED");
}
