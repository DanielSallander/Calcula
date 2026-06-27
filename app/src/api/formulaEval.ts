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
