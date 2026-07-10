//! FILENAME: app/extensions/_shared/dsl/pivotLayout/paramNames.ts
// PURPOSE: The @param NAME grammar shared by the Reports substitution engine and
//   the Monaco @-completion, so what the editor inserts is always what the
//   substitution can parse:
//     @Name        bare  — unicode letters/digits/underscore, starts letter or `_`
//     @"Any name"  quoted — anything except `"` (spaces, dots, etc.)

/** Bare param name matcher (anchored at the string start). */
export const BARE_PARAM_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** True when a name is expressible as a bare `@Name` token (no quoting needed). */
export function isBareParamName(name: string): boolean {
  const m = BARE_PARAM_NAME_RE.exec(name);
  return m !== null && m[0].length === name.length;
}

/**
 * The `@` reference text for a control name: bare when possible, else `@"quoted"`.
 * Returns undefined for names the grammar cannot express (containing `"`).
 */
export function paramReference(name: string): string | undefined {
  if (isBareParamName(name)) return `@${name}`;
  if (name.includes('"')) return undefined;
  return `@"${name}"`;
}
