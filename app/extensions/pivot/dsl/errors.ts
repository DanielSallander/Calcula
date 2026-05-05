//! FILENAME: app/extensions/Pivot/dsl/errors.ts
// PURPOSE: Error types with line/column positions for DSL diagnostics.
// CONTEXT: Used across lexer, parser, compiler, and validator stages.

/** Source location within the DSL text. */
export interface SourceLocation {
  line: number;    // 1-based
  column: number;  // 0-based
  endColumn: number;
}

/** Severity levels for DSL diagnostics. */
export type DslSeverity = 'error' | 'warning' | 'info';

/** A diagnostic produced by any DSL pipeline stage. */
export interface DslError {
  message: string;
  severity: DslSeverity;
  location: SourceLocation;
}

/** Create an error diagnostic. */
export function dslError(message: string, location: SourceLocation): DslError {
  return { message, severity: 'error', location };
}

/** Create a warning diagnostic. */
export function dslWarning(message: string, location: SourceLocation): DslError {
  return { message, severity: 'warning', location };
}

/** Create an info diagnostic. */
export function dslInfo(message: string, location: SourceLocation): DslError {
  return { message, severity: 'info', location };
}

/** Placeholder location for errors without a specific position. */
export const NO_LOCATION: SourceLocation = { line: 1, column: 0, endColumn: 0 };
