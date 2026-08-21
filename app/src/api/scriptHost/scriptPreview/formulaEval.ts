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
  /**
   * Set when the evaluator DELIBERATELY refused the batch (the cell cap), with
   * the reason. Distinct from the catch path on purpose: a missing backend is
   * silent (the grid keeps what it had, as before the feature existed), but a
   * refusal is an ANSWER and must reach the report — a script that grew the
   * grid past the cap used to have its formulas read back empty with no
   * indication anywhere.
   */
  refused?: string | null;
  values: PreviewFormulaValue[];
  /** False when the pass budget ran out — a cycle, or a volatile function. */
  converged: boolean;
  passes: number;
  /**
   * Dynamic-array (spilling) formulas the evaluator refused to collapse.
   * A spill writes its NEIGHBORS too, which a single-cell result cannot
   * express — the first element alone would be a wrong answer wearing the
   * right cell. When any formula spills, no values are stored at all.
   */
  spilled: number;
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
 * Recompute every formula in the grid and store the results as cached values —
 * under three honesty rules the adversarial review forced (§5c.1), each of
 * which exists because the first version broke it and thereby DESTROYED truth
 * the snapshot already carried:
 *
 *  1. STORE ONLY ON CONVERGENCE. A half-iterated fixed point is a set of
 *     numbers the workbook would never show; presenting them made a plain
 *     running-total column read as garbage. An unconverged pass stores nothing
 *     and says so.
 *  2. STORE NOTHING WHEN ANYTHING SPILLS. A dynamic-array formula writes its
 *     neighbors; a single-cell result cannot express that, and its first
 *     element alone is a wrong answer wearing the right cell.
 *  3. A COMPUTED ERROR NEVER REPLACES AN EXISTING VALUE. The evaluator sees
 *     one sheet, no named ranges, no UDFs — so `=Sheet2!A1` computes #REF!
 *     where the workbook computed 250. An error result may FILL an empty
 *     display (a script-written `=1/0` genuinely errors), but overwriting a
 *     workbook value with one reports the evaluator's horizon as the
 *     script's defect.
 *
 * Returns a note when the values could not be (fully) stored, so the report
 * can say so; undefined when there was nothing to do or everything settled.
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

  if (result.refused) {
    return (
      `${result.refused} — formula values shown are the workbook's last computed ones, and ` +
      `formulas the script wrote have none`
    );
  }
  if (result.spilled > 0) {
    return (
      `${result.spilled} formula${result.spilled === 1 ? "" : "s"} produce${result.spilled === 1 ? "s" : ""} ` +
      `a spilled array, which the preview cannot evaluate — formula values shown are the ` +
      `workbook's last computed ones`
    );
  }
  if (!result.converged) {
    return (
      `the sheet's formulas did not settle within the evaluation budget (${result.passes} passes — ` +
      `a circular reference, or a volatile function like RAND/NOW) — formula values shown are ` +
      `the workbook's last computed ones`
    );
  }

  let kept = 0;
  for (const v of result.values) {
    const existing = grid.cachedDisplay(v.row, v.col);
    const isError = v.display.startsWith("#");
    if (isError && existing !== undefined && !existing.startsWith("#")) {
      kept++;
      continue;
    }
    grid.setCachedDisplay(v.row, v.col, v.display);
  }
  return kept > 0
    ? `${kept} formula${kept === 1 ? "" : "s"} the preview cannot evaluate (references outside ` +
        `this sheet, or functions it does not have) kept the workbook's computed value${kept === 1 ? "" : "s"}`
    : undefined;
}
