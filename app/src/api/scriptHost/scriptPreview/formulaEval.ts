//! FILENAME: app/src/api/scriptHost/scriptPreview/formulaEval.ts
// PURPOSE: Fill in the VALUES of formulas the preview grid holds, by asking the
//          one component that can compute them.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          WHY IT IS NOT DONE IN TYPESCRIPT. The formula language, its
//          functions and its reference semantics live in Rust. Reimplementing
//          any of it here would be a second evaluator that disagrees with the
//          workbook — the single worst kind of drift a preview could carry,
//          because it would report confident numbers the product would never
//          produce. `preview_evaluate_formulas` is a PURE Rust function over
//          the cells this module hands it: no AppState, no document, no writes.
//
//          WHEN IT RUNS. At the preview's settle points — after `setup`, and
//          after each hook fires — rather than on every read. That is a
//          deliberate approximation and it is stated in §5c: the product
//          recalculates as part of the write, so a read immediately after a
//          write sees the new value there, while here it sees it on the next
//          settle. Doing it per-read would mean an IPC round trip inside a
//          synchronous backend call, which the backend's shape does not allow
//          and which would make a preview slower than the thing it previews.
//
//          FAILURE IS SILENT ON PURPOSE. If the evaluator is unavailable the
//          grid keeps the values it had, which is exactly the behaviour the
//          preview had before this existed. A dry run must not start failing
//          because an enrichment could not run.

import type { PreviewGrid } from "./grid";

export interface PreviewFormulaValue {
  row: number;
  col: number;
  display: string;
}

export interface PreviewEvalResult {
  values: PreviewFormulaValue[];
  /** False when the pass budget ran out — a cycle, or a very deep chain. */
  converged: boolean;
  passes: number;
}

/** The evaluator, injected so this module is testable with no backend. */
export type FormulaEvaluator = (
  cells: Array<{ row: number; col: number; input: string }>,
  sheetName: string,
) => Promise<PreviewEvalResult>;

/** The real one: the pure Rust command. */
export async function backendEvaluator(
  cells: Array<{ row: number; col: number; input: string }>,
  sheetName: string,
): Promise<PreviewEvalResult> {
  const { invokeBackend } = await import("../../backend");
  return invokeBackend<PreviewEvalResult>("preview_evaluate_formulas", { cells, sheetName });
}

/**
 * Recompute every formula in the grid and store the results as cached values.
 *
 * Returns a note when the values are NOT trustworthy as final — a cycle or a
 * chain deeper than the budget — so the caller can say so rather than present
 * a half-iterated number as the answer. Returns undefined when there was
 * nothing to do or everything settled.
 */
export async function recalculatePreviewGrid(
  grid: PreviewGrid,
  sheetName: string,
  evaluate: FormulaEvaluator,
): Promise<string | undefined> {
  const cells = grid.entries().map(({ row, col, cell }) => ({ row, col, input: cell.input }));
  if (!cells.some((c) => c.input.startsWith("="))) return undefined;

  let result: PreviewEvalResult;
  try {
    result = await evaluate(cells, sheetName);
  } catch {
    // See the header: an enrichment that cannot run leaves the grid as it was.
    return undefined;
  }

  for (const v of result.values) {
    grid.setCachedDisplay(v.row, v.col, v.display);
  }
  return result.converged
    ? undefined
    : `some formulas did not settle in ${result.passes} passes (a circular reference, or a very deep chain), ` +
        `so their values are not final`;
}
