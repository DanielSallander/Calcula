//! FILENAME: app/extensions/_shared/dsl/pivotLayout/controlRefs.ts
// PURPOSE: Field parameters — @CONTROL(name) substitution in pivot DSL text.
// CONTEXT: A DSL clause may reference a named pane control / ribbon filter
//   (Controls pane) wherever a field name or literal is expected, e.g.
//   `ROWS: @CONTROL(GroupField)`. Before lexing, each reference is replaced
//   with the control's CURRENT value, so a dropdown control listing field
//   names acts like a Power BI "field parameter": the user flips the control,
//   the design is re-applied, and the pivot regroups. This module is pure —
//   the caller supplies the resolver (the app layer wires it to
//   @api getControlValue), keeping the DSL package free of app imports.

import type { DslError, SourceLocation } from './errors';
import { dslError } from './errors';

/** `@CONTROL(name)` — name is anything up to the closing paren, trimmed. */
const CONTROL_REF = /@CONTROL\(([^)]*)\)/gi;

/** Resolve a control name to its substitution text, or undefined if unknown. */
export type ControlResolver = (name: string) => string | undefined;

export interface ControlSubstitutionResult {
  /** The DSL text with every @CONTROL(...) reference replaced. */
  text: string;
  /** Names referenced (deduplicated, in first-occurrence order) — lets the
   *  caller subscribe to changes of exactly these controls. */
  controls: string[];
  /** One error per unresolvable or empty reference (fail visibly, not
   *  silently: an unresolved reference compiles to nothing useful). */
  errors: DslError[];
}

/** 1-based line + 0-based column of a character offset in `text`. */
function locate(text: string, offset: number, length: number): SourceLocation {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  const column = offset - lineStart;
  return { line, column, endColumn: column + length };
}

/**
 * Replace every `@CONTROL(name)` in `text` with the resolver's value for
 * `name`. Unresolved references are left in place (so the lexer's error
 * points at them too) and reported in `errors`.
 */
export function substituteControlRefs(
  text: string,
  resolve: ControlResolver,
): ControlSubstitutionResult {
  const controls: string[] = [];
  const errors: DslError[] = [];
  const out = text.replace(CONTROL_REF, (match: string, rawName: string, offset: number) => {
    const name = rawName.trim();
    if (name === '') {
      errors.push(
        dslError('@CONTROL(...) needs a control name', locate(text, offset, match.length)),
      );
      return match;
    }
    if (!controls.some((c) => c.toLowerCase() === name.toLowerCase())) {
      controls.push(name);
    }
    const value = resolve(name);
    if (value === undefined || value.trim() === '') {
      errors.push(
        dslError(
          `Unknown or empty control '${name}' — @CONTROL(...) needs a named control ` +
            `from the Controls pane with a current value`,
          locate(text, offset, match.length),
        ),
      );
      return match;
    }
    return value;
  });
  return { text: out, controls, errors };
}
