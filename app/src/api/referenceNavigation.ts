//! FILENAME: app/src/api/referenceNavigation.ts
// PURPOSE: The feature-neutral seam for "go to what this text names" -- an
//          address or range (this sheet or another), a table reference, a
//          defined name, a table, a floating grid's own address -- so an
//          extension's Go To dialog navigates exactly the way the Name Box does.
// CONTEXT: Home tab 2026-10-04 (navigate.goTo, F5 / Ctrl+G). The Name Box owns
//          that navigation (src/shell/FormulaBar/NameBox.navigate.ts): the sheet
//          switch with its BUG-0052 priming, the merge expansion of a single
//          cell, the backend resolution of names and tables (which knows the
//          SHEET they live on), the canvas refusal, the floating grid's own
//          addresses asked first. A Go To dialog that re-implemented those would
//          be a second answer to "where is Sales[Margin]", one change away from
//          disagreeing with the first -- the drift the Seam Rule exists to
//          prevent. Inversion of Control, like the other seams: the SHELL
//          registers the navigator; @api imports nothing from the shell.

/** What a navigation did. */
export type ReferenceNavigationResult =
  /** The selection moved to what the text names. */
  | { kind: "done" }
  /** The text names something that cannot be gone to; say this sentence. */
  | { kind: "problem"; message: string }
  /** Nothing the text could name (not an address, a reference or a name). */
  | { kind: "unclaimed" };

export type ReferenceNavigator = (text: string) => Promise<ReferenceNavigationResult>;

let navigator: ReferenceNavigator | null = null;

/**
 * Register the navigator. Called once by the shell; returns the unregister,
 * which clears it only if it is still the one registered.
 */
export function registerReferenceNavigator(next: ReferenceNavigator): () => void {
  navigator = next;
  return () => {
    if (navigator === next) navigator = null;
  };
}

/** Whether navigation by reference is available. */
export function hasReferenceNavigator(): boolean {
  return navigator !== null;
}

/**
 * Go to what `text` names. With no navigator registered the answer is a
 * PROBLEM (never "unclaimed"): a caller must not tell the user their valid
 * reference is not valid because the shell is not there.
 */
export async function navigateToReference(text: string): Promise<ReferenceNavigationResult> {
  if (!navigator) {
    return { kind: "problem", message: "Navigation is not available (the workbook view is not ready)." };
  }
  return navigator(text);
}

/** Test hook. */
export function resetReferenceNavigator(): void {
  navigator = null;
}
