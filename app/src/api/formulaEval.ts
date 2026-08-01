//! FILENAME: app/src/api/formulaEval.ts
// PURPOSE: Scope-injected expression evaluation for extensions.
// CONTEXT: Lets extensions evaluate Excel-like expressions over per-row
//   variable scopes using the REAL formula engine (Rust parser + evaluator),
//   instead of shipping a hand-rolled TS parser/evaluator. This is the
//   sanctioned replacement for in-extension formula evaluators (e.g. a chart
//   "calculate"/"filter" expression over data rows). Computation lives in Rust
//   ("The Bridge, not the Monolith").

import { invokeBackend } from "./backend";

/** A scalar value bound to a name in an evaluation scope. */
export type ScopeValue = number | string | boolean | null;

/** A scope: variable name -> value. */
export type EvalScope = Record<string, ScopeValue>;

/** An evaluation result (engine errors surface as "#…!" strings). */
export type EvalResultValue = number | string | boolean | null | EvalResultValue[];

/**
 * Evaluate ONE Excel-like expression against MANY variable scopes.
 *
 * Bare identifiers in the expression resolve to the scope values
 * (case-insensitive), exactly like LET/LAMBDA bindings — e.g. `Revenue - Cost`
 * with `{ Revenue: 100, Cost: 40 }` yields `60`. Full function/operator support
 * (IF, ROUND, SUM, `&` concat, comparisons, ...). The expression is parsed ONCE
 * and evaluated per scope, so this is efficient for per-row work.
 *
 * Cell references (A1) are NOT resolved — there is no grid context.
 *
 * @returns one result per scope (same order). Rejects on a syntax error.
 */
export async function evaluateScoped(
  expression: string,
  scopes: EvalScope[],
): Promise<EvalResultValue[]> {
  return invokeBackend<EvalResultValue[]>("evaluate_scoped", { expression, scopes });
}

/** Evaluate one expression against a single scope (convenience wrapper). */
export async function evaluateExpression(
  expression: string,
  scope: EvalScope = {},
): Promise<EvalResultValue> {
  const [result] = await evaluateScoped(expression, [scope]);
  return result;
}

// ============================================================================
// Grid-backed TYPED evaluation (the WorksheetFunction bridge)
// ============================================================================
// `evaluateScoped` above has no grid: it binds names, not cells. This pair does
// the opposite — it evaluates against the workbook's LIVE grid, so `SUM(A1:A10)`
// and `VLOOKUP(...)` mean what they mean in a cell — and it keeps the engine's
// typing instead of flattening everything to a display string.
//
// This is what backs `api.evaluate(...)` in the script sandbox (VBA's
// `Application.WorksheetFunction.*`): 400+ built-in functions reachable without
// writing a formula into a scratch cell and reading it back.

/**
 * One evaluated expression, typed. Mirrors Rust `TypedEvalResult`
 * (app/src-tauri/src/api_types.rs) — the same value/display/type triple
 * {@link TypedCellData} carries, minus the coordinates and the formula.
 *
 * - `value`: number | string | boolean | null (an error carries its Excel
 *   literal, e.g. "#DIV/0!"; an array/list result carries its rendered text).
 * - `display`: the formatted text the same result would show in a cell.
 * - `type`: number | text | boolean | empty | error.
 */
export interface TypedEvalResult {
  value: number | string | boolean | null;
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
}

/**
 * Evaluate formula expressions against the workbook's live grid, TYPED.
 *
 * Cell references resolve (unqualified ones against `sheetIndex`, which defaults
 * to the active sheet); a leading `=` is optional; an expression that does not
 * parse yields `#SYNTAX!` in its own slot rather than failing the batch.
 *
 * TWO HONEST LIMITS, both inherited from the backend command:
 *  - user-defined functions are NOT resolved (an unknown name answers `#NAME?`).
 *    A UDF's body is JavaScript in another script's worker realm; resolving one
 *    here would re-enter that realm synchronously from inside a lock-held
 *    evaluation.
 *  - GETPIVOTDATA / GET.CONTROLVALUE have no source wired, exactly as in
 *    `evaluate_expressions`.
 */
export async function evaluateFormulasTyped(
  expressions: string[],
  sheetIndex?: number,
): Promise<TypedEvalResult[]> {
  if (expressions.length === 0) return [];
  return invokeBackend<TypedEvalResult[]>("evaluate_formula_typed", {
    expressions,
    sheetIndex: sheetIndex ?? null,
  });
}

/** Evaluate ONE expression against the live grid (convenience wrapper). */
export async function evaluateFormulaTyped(
  expression: string,
  sheetIndex?: number,
): Promise<TypedEvalResult> {
  const [result] = await evaluateFormulasTyped([expression], sheetIndex);
  return result;
}
