//! FILENAME: app/src/api/formulaAssistService.ts
// PURPOSE: The feature-neutral seam through which anything can ask for a
//          formula, without importing the extension that knows how to get one.
// CONTEXT: The AI chat wants this (a "write me a formula" message should not
//          become a tool-loop guess), the grid context menu wants it for "fix
//          this formula", and a future intent router wants it as the whole of
//          its `formula` specialist. All three would otherwise reach into the
//          FormulaAssist extension, which the Facade Rule forbids and which
//          would make FormulaAssist un-removable.
//
//          THE SEAM CARRIES THE VERIFICATION, NOT JUST THE TEXT. A caller must
//          be able to tell a formula the engine has CHECKED from one it has
//          not, because those two things earn different UI: one may be offered
//          with its computed answer, the other must be offered as a guess. A
//          seam that returned only a string would make that distinction
//          impossible to draw and it would quietly stop being drawn.

/** What the engine made of a proposal. Absent when it was never checked. */
export interface FormulaVerification {
  /** True only when the formula parsed AND evaluated at the target cell. */
  verified: boolean;
  /** What the target cell would show. Empty when evaluation did not happen. */
  display: string;
  /** The first three filled-down rows, when the proposal is a fill-down. */
  fillDownDisplays: readonly string[];
  /** `#DIV/0!` and friends, when the formula evaluates to an error. */
  error?: string;
  /** Present when the formula spills, as rows by columns. */
  spill?: readonly [number, number];
  /** One line per finding, already worded for a person. */
  findings: readonly string[];
  /**
   * Why nothing could be judged, when that is the answer.
   *
   * A rung that cannot run DECLINES rather than guessing, and the caller must
   * show that state rather than a confident preview of an unchecked formula.
   */
  declineReason?: string;
}

export interface FormulaAssistRequest {
  /** What the user asked for, in their words. */
  intent: string;
  sheetIndex: number;
  row: number;
  col: number;
  /** A result the user stated, when they gave one ("should be 15%"). */
  expected?: string;
  /** Cancels a slow local model without leaving the caller's UI spinning. */
  signal?: AbortSignal;
}

export interface FormulaProposal {
  status: "verified" | "unverified" | "declined" | "no-model";
  /** Comma-separated, dot decimals. What gets stored. */
  formulaInvariant: string;
  /** The user's own separators. What gets SHOWN and what gets typed into a cell. */
  formulaLocalized: string;
  explanation: string;
  assumptions: readonly string[];
  fillDown: boolean;
  verification: FormulaVerification | null;
  target: { sheetIndex: number; row: number; col: number; a1: string };
  /** How many model round trips it took. 1 means first time. */
  rounds: number;
  model: string;
  /** One sentence for a person when `status` is not `verified`. */
  summary: string;
}

export interface FormulaAssistProvider {
  /** False when no model is configured. Explains a disabled control rather than gating one. */
  isConfigured(): boolean;
  modelLabel(): string;
  /** Ask for a formula. Rejects only on a transport failure; a bad answer is a RESULT. */
  assistFormula(req: FormulaAssistRequest): Promise<FormulaProposal>;
  /**
   * Write an accepted proposal into the grid as ONE undoable edit.
   *
   * On the provider rather than the caller because insertion is the moment the
   * feature touches the document: it goes through the ordinary cell-input path
   * so delocalization, dependency tracking, spill handling and undo all behave
   * exactly as they do when a person types, and it records an audit row. A
   * caller that wrote the cell itself would get some of that and not the rest.
   */
  insertProposal(proposal: FormulaProposal): Promise<void>;
  /**
   * Explain an existing formula with NO model involved.
   *
   * Tier 0: the parsed syntax tree plus the function catalogue is enough to say
   * what a formula does, and it works with no provider configured, offline, and
   * with an answer that cannot be wrong about the product.
   */
  explainFormula(sheetIndex: number, row: number, col: number): Promise<string>;
}

let provider: FormulaAssistProvider | null = null;

/** Register the provider. Returns the unregister function for a cleanup list. */
export function registerFormulaAssistProvider(next: FormulaAssistProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

export function hasFormulaAssistProvider(): boolean {
  return provider !== null;
}

/** The provider, or null. Prefer this where the caller has something else to offer. */
export function getFormulaAssistProvider(): FormulaAssistProvider | null {
  return provider;
}

/** The provider. THROWS when absent, so a caller can turn it into a readable sentence. */
export function requireFormulaAssistProvider(): FormulaAssistProvider {
  if (!provider) {
    throw new Error(
      "The formula assistant is unavailable: the Formula Assist extension is not loaded.",
    );
  }
  return provider;
}

/** Test/reset hook. */
export function resetFormulaAssistProvider(): void {
  provider = null;
}
