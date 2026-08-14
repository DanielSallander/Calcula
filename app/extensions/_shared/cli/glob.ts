// FILENAME: app/extensions/_shared/cli/glob.ts
// PURPOSE: Domain-agnostic glob matching for CLI targets: `*` = any run,
//          `?` = one char, matched case-insensitively against object names.
//          The kind-specific matchers (tables, columns, relationships…) stay
//          with their domain — this is only the machinery they share.

import { CliError } from "./lex";

export function isPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

/** Compile a glob (`*` = any run, `?` = one char) to a case-insensitive,
 *  whole-string regex. A non-pattern compiles to an exact (ci) match. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

export function globMatch(pattern: string, name: string): boolean {
  return globToRegex(pattern).test(name);
}

/** Filter names by a glob; exact (ci) names pass through unchanged. */
export function filterNames(pattern: string | null, names: string[]): string[] {
  if (pattern === null || pattern === "" || pattern === "*") return names;
  const re = globToRegex(pattern);
  return names.filter((n) => re.test(n));
}

/** Generic by-name matcher for list-shaped collections. */
export function matchNamed<T>(items: T[], nameOf: (item: T) => string, pattern: string): T[] {
  const re = globToRegex(pattern);
  return items.filter((it) => re.test(nameOf(it)));
}

/** Resolve to exactly one item or fail with a helpful message. */
export function requireOne<T>(
  items: T[],
  nameOf: (item: T) => string,
  pattern: string,
  kindLabel: string,
  line: number,
): T {
  const matches = matchNamed(items, nameOf, pattern);
  if (matches.length === 0) throw new CliError(`No ${kindLabel} matches '${pattern}'`, line);
  if (matches.length > 1) {
    throw new CliError(
      `'${pattern}' matches ${matches.length} ${kindLabel}s (${matches
        .slice(0, 6)
        .map(nameOf)
        .join(", ")}${matches.length > 6 ? ", …" : ""}) — be specific`,
      line,
    );
  }
  return matches[0];
}
