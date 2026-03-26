//! FILENAME: app/extensions/DefinedNames/lib/lambdaUtils.ts
// PURPOSE: Utility functions for building and parsing LAMBDA-based named ranges.
// CONTEXT: Used by NewFunctionDialog to wrap/unwrap LAMBDA formulas.

import type { NamedRange } from "../../../src/api/lib";

/**
 * Reserved folder name for custom functions.
 * Used to identify named ranges that are custom functions.
 */
export const FUNCTION_FOLDER_NAME = "_Functions";

/**
 * Build a refersTo formula string from parameters and body expression.
 * Example: params ["x", "y"], body "x + y" => "=LAMBDA(x, y, x + y)"
 */
export function buildLambdaRefersTo(params: string[], body: string): string {
  const parts = [...params, body];
  return `=LAMBDA(${parts.join(", ")})`;
}

/**
 * Parse a LAMBDA refersTo formula into parameters and body.
 * Returns null if the formula is not a valid LAMBDA.
 *
 * Uses parenthesis depth tracking and string literal awareness
 * to correctly find the boundary between parameters and body.
 */
export function parseLambdaRefersTo(
  refersTo: string
): { params: string[]; body: string } | null {
  // Strip leading = and whitespace
  let formula = refersTo.trim();
  if (formula.startsWith("=")) {
    formula = formula.substring(1).trim();
  }

  // Check for LAMBDA( prefix (case-insensitive)
  if (!formula.toUpperCase().startsWith("LAMBDA(")) {
    return null;
  }

  // Find the matching closing parenthesis for the outer LAMBDA(
  const innerStart = formula.indexOf("(") + 1;
  let depth = 1;
  let inString = false;
  let stringChar = "";
  let outerEnd = -1;

  for (let i = innerStart; i < formula.length; i++) {
    const ch = formula[i];

    if (inString) {
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        outerEnd = i;
        break;
      }
    }
  }

  if (outerEnd === -1) return null;

  const inner = formula.substring(innerStart, outerEnd).trim();
  if (!inner) return null;

  // Split the inner content by commas at depth 0.
  // The last segment is the body, all preceding are parameter names.
  const segments: string[] = [];
  let segStart = 0;
  depth = 0;
  inString = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (inString) {
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      segments.push(inner.substring(segStart, i).trim());
      segStart = i + 1;
    }
  }
  // Push last segment
  segments.push(inner.substring(segStart).trim());

  if (segments.length < 2) return null;

  const params = segments.slice(0, -1);
  const body = segments[segments.length - 1];

  // Validate that all params look like identifiers
  for (const p of params) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(p)) {
      return null;
    }
  }

  return { params, body };
}

/**
 * Check whether a named range is a custom function.
 */
export function isCustomFunction(nr: NamedRange): boolean {
  return nr.folder === FUNCTION_FOLDER_NAME;
}

/**
 * Format a function's signature for display in the Name Manager.
 * Returns e.g. "(x, y)" or "(amount, rate)".
 */
export function formatFunctionSignature(nr: NamedRange): string {
  const parsed = parseLambdaRefersTo(nr.refersTo);
  if (!parsed) return nr.refersTo;
  return `(${parsed.params.join(", ")})`;
}
