//! FILENAME: app/extensions/FormulaAssist/lib/backend.ts
// PURPOSE: Typed wrappers for the two backend commands this feature owns, and
//          the mapping from what Rust says into what the `@api` seam promises.
// CONTEXT: Reached through `createBackendChannel`, bound to `ctx.invokeBackend`
//          in activate(), because `invoke` takes a STRING: an extension that
//          imports Tauri directly gets an ungated door AND a command name no
//          gate can see. `backendCommandDrift.test.ts` reads the names out of
//          calls like these, so both commands must be spelled here and nowhere
//          else in the extension.
//
//          THE MAPPING IS THE INTERESTING PART. `FormulaVerifyReport` is the
//          engine's report — rungs, verdicts, a flat list of evaluated cells.
//          `FormulaVerification` is the seam's promise to a caller that has to
//          decide what UI a formula earns. Doing the translation here, once,
//          is what keeps "verified" from being re-derived slightly differently
//          in the popover, in the chat and in a future router.

import { createBackendChannel } from "@api/backendCommands";
import type { FormulaVerification } from "@api/formulaAssistService";
import type { FormulaColumnKind, FormulaRegionContext } from "@api/formulaAssist";

/** Bound to `ctx.invokeBackend` at the top of activate(). */
export const formulaAssistBackend = createBackendChannel("FormulaAssist");

// ---------------------------------------------------------------------------
// formula_context
// ---------------------------------------------------------------------------

export interface RegionContextColumn {
  letter: string;
  header?: string | null;
  kind: FormulaColumnKind;
  isTarget: boolean;
  /** The formula the column's other rows already use, when they share one. */
  formulaPattern?: string | null;
}

export interface RegionContextTable {
  name: string;
  columns: string[];
  targetColumn?: string | null;
}

/** What `formula_context` reports about the data around the target cell. */
export interface RegionContext {
  sheetName: string;
  target: string;
  targetRow: number;
  targetCol: number;
  targetIsEmpty: boolean;
  targetFormula?: string | null;
  range?: string | null;
  hasHeaderRow: boolean;
  dataRowCount: number;
  columns: RegionContextColumn[];
  sampleRows: string[][];
  table?: RegionContextTable | null;
  /** The backend's own rendered block. Kept for diagnostics — see below. */
  text: string;
  tokenEstimate: number;
}

export async function fetchFormulaContext(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<RegionContext> {
  return formulaAssistBackend.invoke<RegionContext>("formula_context", {
    sheetIndex,
    row,
    col,
  });
}

/**
 * The backend context in the shape `buildUserPrompt` was MEASURED against.
 *
 * The command also returns a pre-rendered `text`, and it is deliberately not
 * what goes into the prompt: `renderRegionContext` is the renderer the offline
 * eval runner scored, and the whole point of putting the prompt pieces in
 * `@api/formulaAssist` was that the product runs the pipeline that was
 * measured rather than a second spelling of it. `text` and `tokenEstimate`
 * stay available for a diagnostic that wants to compare the two.
 */
export function toPromptContext(ctx: RegionContext): FormulaRegionContext {
  return {
    sheet: ctx.sheetName,
    target: ctx.target,
    targetIsEmpty: ctx.targetIsEmpty,
    range: ctx.range ?? ctx.target,
    hasHeaderRow: ctx.hasHeaderRow,
    dataRowCount: ctx.dataRowCount,
    columns: ctx.columns.map((c) => ({
      letter: c.letter,
      header: c.header ?? null,
      kind: c.kind,
      isTarget: c.isTarget,
    })),
    sampleRows: ctx.sampleRows,
  };
}

/** The header words that say what this data is ABOUT, for retrieval. */
export function headerWords(ctx: RegionContext | null): string[] {
  if (!ctx) return [];
  const words = ctx.columns
    .map((c) => c.header)
    .filter((h): h is string => typeof h === "string" && h.trim() !== "");
  if (ctx.table) {
    words.push(ctx.table.name, ...ctx.table.columns);
  }
  return words;
}

// ---------------------------------------------------------------------------
// formula_assist_verify
// ---------------------------------------------------------------------------

export interface FormulaVerifyRequest {
  formula: string;
  sheetIndex: number;
  row: number;
  col: number;
  /** How many rows below the target to evaluate the filled-down copy over. */
  fillDownRows: number;
}

export interface FormulaVerifyFinding {
  code: string;
  message: string;
  hint?: string | null;
}

export interface FormulaVerifyValue {
  row: number;
  col: number;
  display: string;
  kind: string;
}

export interface FormulaVerifyReport {
  /** Invariant form: commas between arguments, dot decimals. What is stored. */
  normalized: string;
  /** The user's own separators. What is SHOWN and what gets typed into a cell. */
  localized: string;
  /** Set when the model wrote a localized formula and the engine had to undo it. */
  delocalizedFromLocale?: string | null;
  rung: "f0" | "f1" | "f2";
  verdict: "verified" | "repair" | "declined";
  findings: FormulaVerifyFinding[];
  values: FormulaVerifyValue[];
  spillRows: number;
  spillCols: number;
  functionsUsed: string[];
  declineReason?: string | null;
}

export async function verifyFormula(
  request: FormulaVerifyRequest,
): Promise<FormulaVerifyReport> {
  return formulaAssistBackend.invoke<FormulaVerifyReport>("formula_assist_verify", {
    request,
  });
}

/** One finding as a sentence, hint folded in when there is one. */
export function findingLine(finding: FormulaVerifyFinding): string {
  return finding.hint ? `${finding.message} ${finding.hint}` : finding.message;
}

/**
 * The engine's report, as the seam's verification.
 *
 * `verified` is NOT `report.verdict === "verified"` on its own — the ladder
 * additionally requires rung f2 (the formula actually EVALUATED at the target),
 * and that decision belongs in one place. This function reports what the engine
 * found; `assistFormula` decides what status it earns.
 */
export function toVerification(
  report: FormulaVerifyReport,
  target: { row: number; col: number },
): FormulaVerification {
  const atTarget = report.values.find(
    (v) => v.row === target.row && v.col === target.col,
  );
  const fillDownDisplays = report.values
    .filter((v) => v.col === target.col && v.row > target.row)
    .sort((a, b) => a.row - b.row)
    .slice(0, 3)
    .map((v) => v.display);

  const spills = report.spillRows > 1 || report.spillCols > 1;

  return {
    verified: report.verdict === "verified" && report.rung === "f2",
    display: atTarget?.display ?? "",
    fillDownDisplays,
    // An engine error is a legitimate answer for some formulas (IFERROR guards
    // are written around them), so it is REPORTED rather than turned into a
    // finding — the UI decides how loudly to say it.
    ...(atTarget && atTarget.kind === "error" ? { error: atTarget.display } : {}),
    ...(spills ? { spill: [report.spillRows, report.spillCols] as const } : {}),
    findings: report.findings.map(findingLine),
    ...(report.declineReason ? { declineReason: report.declineReason } : {}),
  };
}
