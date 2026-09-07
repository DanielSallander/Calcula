//! FILENAME: app/src/api/formulaAssist/types.ts
// PURPOSE: The shapes the formula assistant and its offline measurement share.
// CONTEXT: These live in `@api` rather than in the eval runner because the
//          runner must measure the PIPELINE THE PRODUCT WILL RUN. A second set
//          of shapes for measurement would let the two drift, and then the
//          number the runner reports would describe something nobody ships.
//
//          Zero imports on purpose: the eval runner bundles this subtree with
//          esbuild and runs it under plain Node, so anything reaching for a
//          browser global or a Tauri command would break the measurement.

/** One fixture cell, as the text a person would TYPE into it. */
export interface FormulaFixtureCell {
  readonly a1: string;
  readonly input: string;
}

/**
 * What a task says the answer should be.
 *
 * Mirrors `Expectation` in `core/calcula-format/src/ai/formula_verify.rs`, which
 * is what actually decides a match. Kept in step by hand because the grader is
 * Rust and this is TypeScript; the field names are identical so a mismatch shows
 * up as a serde error rather than as a silently ignored expectation.
 */
export interface FormulaExpectation {
  readonly kind: "number" | "text" | "boolean" | "error" | "display";
  readonly number?: number;
  readonly text?: string;
  readonly boolean?: boolean;
  readonly error?: string;
  readonly display?: string;
  readonly tolerance?: number;
}

/** The column kinds the context block reports. */
export type FormulaColumnKind = "number" | "text" | "date" | "boolean" | "formula" | "empty";

export interface FormulaContextColumn {
  readonly letter: string;
  /** The header text, when the region has a header row. */
  readonly header: string | null;
  readonly kind: FormulaColumnKind;
  /** True when this is the column the target cell sits in. */
  readonly isTarget: boolean;
}

/** What the model is told about the data it is writing a formula over. */
export interface FormulaRegionContext {
  readonly sheet: string;
  readonly target: string;
  readonly targetIsEmpty: boolean;
  readonly range: string;
  readonly hasHeaderRow: boolean;
  readonly dataRowCount: number;
  readonly columns: readonly FormulaContextColumn[];
  /** Up to three data rows, each already truncated per cell. */
  readonly sampleRows: readonly (readonly string[])[];
}

/** What the model is asked to return. */
export interface FormulaProposal {
  readonly formula: string;
  readonly explanation: string;
  readonly assumptions: readonly string[];
  readonly fillDown: boolean;
}

/** A worked example retrieved to show the model what good looks like. */
export interface RetrievablePattern {
  readonly id: string;
  readonly fn: string;
  readonly intent: string;
  readonly formula: string;
  readonly result: string;
}
