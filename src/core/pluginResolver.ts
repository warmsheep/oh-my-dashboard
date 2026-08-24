import * as defaultFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getValue } from "./jsoncEditor";
import { readdirSafe, readDirTree } from "./skillScanner";
import type { ParseResult, PluginEntry } from "./types";

/** Nested dependency dirs never shown in plugin file trees. */
const PLUGIN_TREE_EXCLUDES = new Set(["node_modules", ".git"]);

/**
 * Plugin specifiers declared in opencode.json[c], normalizing BOTH syntaxes: the V1
 * `plugin` string array and the V2 `plugins` array whose object entries expose a
 * `package` field (object entries work under either key). `plugin` wins when present;
 * non-string entries without a usable `package` are dropped; order is preserved.
 * Shared by listPlugins() and resolveAgentConfig()'s omo-plugin check so the two
 * consumers can never read the declaration list differently.
 */
export function declaredPluginSpecifiers(text: string): string[] {
  const raw = getValue<unknown>(text, ["plugin"]) ?? getValue<unknown>(text, ["plugins"]);
  if (!Array.isArray(raw)) {
    return [];
  }
  const specifiers: string[] = [];
  for (const item of raw) {
    const specifier =
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object" && typeof (item as { package?: unknown }).package === "string"
          ? (item as { package: string }).package.trim()
          : "";
    if (specifier !== "") {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Machine context the resolver needs; readPackageJson lets ConfigStore memoize the parse. */
export interface PluginHost {
  configDir: string;
  pluginCacheDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  readPackageJson<T>(filePath: string): ParseResult<T>;
}

/** Mirrors upstream isPathPluginSpec (file:// / . / absolute) plus ~, which npm names cannot contain. */
function isPathPluginSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("file://") ||
    specifier.startsWith("~") ||
    specifier.startsWith(".") ||
    path.isAbsolute(specifier)
  );
}

/** @scope/name@1.0.0 → cut at the 2nd @; name@1.0.0 → cut at the 1st. */
function npmPluginName(specifier: string): string {
  const from = specifier.startsWith("@") ? specifier.indexOf("@", 1) : specifier.indexOf("@");
  return from === -1 ? specifier : specifier.slice(0, from);
}

/** Mirrors opencode's npm.ts sanitize(): on win32, path-illegal chars become "_". */
function sanitizePkgDir(spec: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return spec;
  }
  const illegal = new Set(["<", ">", ":", '"', "|", "?", "*"]);
  return Array.from(spec, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("");
}

/**
 * Resolve every declared plugin (from opencode.json[c] text) against this machine:
 * npm entries against the runtime cache first, then <configDir>/node_modules; path
 * entries (~/, ./, /, file://) against home / configDir. Declaration order preserved.
 */
export function listDeclaredPlugins(text: string, host: PluginHost): PluginEntry[] {
  return declaredPluginSpecifiers(text).map((specifier) => resolvePlugin(specifier, host));
}

function resolvePlugin(specifier: string, host: PluginHost): PluginEntry {
  return isPathPluginSpecifier(specifier) ? resolvePathPlugin(specifier, host) : resolveNpmPlugin(specifier, host);
}

function resolvePathPlugin(specifier: string, host: PluginHost): PluginEntry {
  // fileURLToPath handles percent-encoding and Windows drive URLs (file:///C:/x);
  // relative forms like file://./x are not valid absolute URLs and fall back to slicing.
  let spec = specifier;
  if (specifier.startsWith("file://")) {
    try {
      spec = fileURLToPath(specifier);
    } catch {
      spec = specifier.slice("file://".length);
    }
  }
  const resolved = spec.startsWith("~") ? path.join(host.homeDir, spec.slice(1)) : path.resolve(host.configDir, spec);
  let stat: defaultFs.Stats | undefined;
  try {
    stat = defaultFs.statSync(resolved);
  } catch {
    stat = undefined;
  }
  const tree = stat?.isDirectory()
    ? readDirTree(resolved, 0, PLUGIN_TREE_EXCLUDES)
    : stat?.isFile()
      ? [{ name: path.basename(resolved), path: resolved, isDir: false }]
      : [];
  return {
    name: path.basename(resolved),
    specifier,
    kind: "path",
    resolvedPath: resolved,
    installed: stat !== undefined,
    tree,
  };
}

function resolveNpmPlugin(specifier: string, host: PluginHost): PluginEntry {
  const name = npmPluginName(specifier);
  const isInstalledDir = (candidate: string): boolean => {
    try {
      return defaultFs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };
  // Modern opencode (arborist) installs each plugin isolated under
  // packages/<spec>/node_modules/<name> — the dir key is `${name}@latest` for bare names,
  // else the raw specifier (see resolvePluginTarget + Npm.directory in opencode's source).
  const dirKey = sanitizePkgDir(specifier === name ? `${name}@latest` : specifier, host.platform);
  const packagesRoot = path.join(host.pluginCacheDir, "packages");
  const candidates = [
    path.join(packagesRoot, dirKey, "node_modules", name),
    path.join(host.pluginCacheDir, "node_modules", name), // bun-era flat layout
    path.join(host.configDir, "node_modules", name),
  ];
  let resolvedPath: string | undefined = candidates.find(isInstalledDir);
  if (resolvedPath === undefined && defaultFs.existsSync(packagesRoot)) {
    // Scan fallback: the exact dir key may drift from our reconstruction (npa normalization,
    // dist-tags) — any packages/<dir>/node_modules/<name> hit counts as installed.
    for (const entry of readdirSafe(packagesRoot)) {
      const candidate = path.join(packagesRoot, entry.name, "node_modules", name);
      if (isInstalledDir(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }
  }
  const installed = resolvedPath !== undefined;
  const finalPath = resolvedPath ?? candidates[0] ?? path.join(packagesRoot, dirKey, "node_modules", name);
  const version = installed ? installedPluginVersion(finalPath, host) : undefined;
  return {
    name,
    specifier,
    kind: "npm",
    resolvedPath: finalPath,
    installed,
    ...(version !== undefined ? { version } : {}),
    tree: installed ? readDirTree(finalPath, 0, PLUGIN_TREE_EXCLUDES) : [],
  };
}

function installedPluginVersion(dir: string, host: PluginHost): string | undefined {
  const parsed = host.readPackageJson<{ version?: unknown }>(path.join(dir, "package.json"));
  return typeof parsed.value?.version === "string" ? parsed.value.version : undefined;
}
