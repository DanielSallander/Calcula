//! FILENAME: app/src/api/scriptLibraries/usesPragma.ts
// PURPOSE: The `// @uses` / `// @uses-isolated` / `// @export` pragma dialect —
//          sibling of `parseDeclaredCapabilities` (scriptHost/capabilities.ts),
//          deliberately the same line-anchored comment shape so scripts have ONE
//          pragma dialect rather than two.
// CONTEXT: A consumer declares its dependencies; a library module declares the
//          names it exports. Both are read by TRUSTED host code from the
//          AUTHORITATIVE source (the same text whose hash was consented) — never
//          from anything the running script sends, and never from a manifest
//          field a publisher could make disagree with the code.
// SECURITY: The parser is deliberately NOT a JS parser. The regex is
//           line-anchored, so a `// @uses …` sequence INSIDE a template literal
//           or a block comment is still matched (identical to the existing
//           `@capability` behaviour — see parseUses' doc comment and the tests).
//           That direction is safe by construction: a pragma can only ever
//           REQUEST a link, and every link is then resolved against the
//           workbook lockfile and intersected down to the consumer's ceiling. A
//           pragma smuggled into a string can therefore make a script fail to
//           mount, never make it reach further.
//           Malformed declarations are HARD ERRORS, not ignored: a dangling or
//           ambiguous import must fail loudly at mount rather than resolve to
//           `undefined` at some later call site.

import type { CapabilityId } from "../scriptHost/capabilityIds";
import { CAPABILITY_ID_SET } from "../scriptHost/capabilityIds";
import { parseDeclaredCapabilities } from "../scriptHost/capabilities";
import type { LibraryUseDeclaration, ModulePragmas } from "./types";

/** A JS identifier — the alias is bound as a property of the `imports` object
 *  and as an export name, so both must be plain identifiers. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** calp package names: dotted/dashed segments, e.g. "acme.stats", "tiny-csv". */
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A permissive shape check for a version pin. The AUTHORITATIVE parse is
 *  Rust's `VersionPin::parse`; this only rejects obvious garbage early so the
 *  error names the offending line instead of surfacing from the backend. */
const PIN_RE = /^(latest|\*|[\^~]?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?)$/;

/** Alias names that would shadow something the generated prelude binds. */
const RESERVED_ALIASES = new Set(["imports", "context", "setup"]);

export interface ParsedUses {
  uses: LibraryUseDeclaration[];
  /** Human-readable problems. A non-empty list MUST fail the mount. */
  errors: string[];
}

/**
 * Scan a script source for `// @uses <alias> <package>@<pin>` (and the
 * `// @uses-isolated` variant, which forces a realm private to this consumer).
 *
 * Line-anchored like `@capability`: leading whitespace and the `//` are all that
 * precede the tag, and the match is NOT JS-aware — a pragma inside a template
 * literal is still seen. See the SECURITY note at the top of this file for why
 * that direction cannot widen reach.
 *
 * A duplicate alias, an unparseable target, a reserved alias, or a missing pin
 * is reported in `errors` rather than silently dropped.
 */
export function parseUses(source: string): ParsedUses {
  const uses: LibraryUseDeclaration[] = [];
  const errors: string[] = [];
  if (typeof source !== "string") return { uses, errors };

  const seen = new Set<string>();
  const pragma = /^[ \t]*\/\/[ \t]*@uses(-isolated)?[ \t]+(\S+)[ \t]+(\S+)[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = pragma.exec(source)) !== null) {
    const isolated = m[1] === "-isolated";
    const alias = m[2];
    const target = m[3];

    if (!IDENT_RE.test(alias)) {
      errors.push(`@uses: "${alias}" is not a valid alias (use a JS identifier).`);
      continue;
    }
    if (RESERVED_ALIASES.has(alias)) {
      errors.push(`@uses: the alias "${alias}" is reserved.`);
      continue;
    }
    if (seen.has(alias)) {
      errors.push(`@uses: the alias "${alias}" is declared more than once.`);
      continue;
    }

    const at = target.lastIndexOf("@");
    if (at <= 0 || at === target.length - 1) {
      errors.push(
        `@uses ${alias}: "${target}" is not a <package>@<pin> target (e.g. acme.stats@^1.2.0).`,
      );
      continue;
    }
    const pkg = target.slice(0, at);
    const pin = target.slice(at + 1);
    if (!PACKAGE_RE.test(pkg)) {
      errors.push(`@uses ${alias}: "${pkg}" is not a valid package name.`);
      continue;
    }
    if (!PIN_RE.test(pin)) {
      errors.push(`@uses ${alias}: "${pin}" is not a valid version pin.`);
      continue;
    }

    seen.add(alias);
    uses.push({ alias, package: pkg, pin, isolated });
  }

  return { uses, errors };
}

/**
 * Scan a LIBRARY module source for `// @export <name>` pragmas. These are the
 * ONLY names an importer can call: the generated dispatcher routes exactly this
 * list, so a function the module returns but did not declare is unreachable.
 * That makes "what can this library do to me" answerable from the source text
 * alone, which is the transparency pillar's requirement.
 */
export function parseExports(source: string): { exports: string[]; errors: string[] } {
  const exports: string[] = [];
  const errors: string[] = [];
  if (typeof source !== "string") return { exports, errors };

  const seen = new Set<string>();
  const pragma = /^[ \t]*\/\/[ \t]*@export[ \t]+(\S+)[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = pragma.exec(source)) !== null) {
    const name = m[1];
    if (!IDENT_RE.test(name)) {
      errors.push(`@export: "${name}" is not a valid export name (use a JS identifier).`);
      continue;
    }
    if (seen.has(name)) continue; // a repeated export is harmless; dedupe quietly
    seen.add(name);
    exports.push(name);
  }
  return { exports, errors };
}

/**
 * Everything the host derives from ONE library module source: its exports, its
 * OWN declared capability ceiling, and its own dependencies. Capabilities go
 * through `parseDeclaredCapabilities` — the SAME parser that builds the R19
 * ceiling for every other script — so "what does this code declare?" has one
 * implementation and cannot drift between the consent prompt and the broker.
 */
export function parseModulePragmas(source: string): {
  pragmas: ModulePragmas;
  errors: string[];
} {
  const { exports, errors: exportErrors } = parseExports(source);
  const { uses, errors: usesErrors } = parseUses(source);
  const declared = parseDeclaredCapabilities(source);
  const capabilities = declared.caps.filter((c): c is CapabilityId => CAPABILITY_ID_SET.has(c));
  return {
    pragmas: { exports, capabilities, netOrigins: declared.origins, uses },
    errors: [...exportErrors, ...usesErrors],
  };
}
