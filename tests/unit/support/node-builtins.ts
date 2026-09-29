import { builtinModules } from "node:module";

// Bun lists its own polyfills among `builtinModules`; Node (and so a bundler) does not treat them as builtins.
const bunOnlyBuiltins = new Set(["bun", "undici", "ws"]);
const nodeBuiltins = new Set(builtinModules.filter((name) => !bunOnlyBuiltins.has(name) && !name.startsWith("bun:")));

/**
 * The Node builtins a module names, by bare name or `node:` prefix, in a static import, a dynamic
 * `import()` or a `require()`. Each is returned once, unprefixed and sorted.
 */
export function builtinSpecifiers(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)|\bfrom\s*["']([^"']+)["']/g),
  ].map((match) => match[1] ?? match[2] ?? "");
  const builtins = specifiers.filter((specifier) => specifier.startsWith("node:") || nodeBuiltins.has(specifier));
  return [...new Set(builtins.map((specifier) => specifier.replace(/^node:/, "")))].sort();
}

/**
 * The builtins among `builtins` that a manifest's `browser` field leaves unstubbed. A browser bundler
 * that meets an unstubbed builtin externalises it with a warning, and it may meet either spelling, so
 * each one must be stubbed (`false`) both bare and `node:`-prefixed.
 */
export function unstubbedBuiltins(builtins: readonly string[], browser: Record<string, unknown> | undefined): string[] {
  return builtins
    .flatMap((builtin) => [builtin, `node:${builtin}`])
    .filter((specifier) => browser?.[specifier] !== false);
}
