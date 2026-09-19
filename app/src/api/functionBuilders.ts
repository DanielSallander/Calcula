//! FILENAME: app/src/api/functionBuilders.ts
// PURPOSE: The feature-neutral seam through which an extension supplies a guided
//          ARGUMENT BUILDER for a function whose arguments the generic Insert
//          Function dialog cannot help with — the second step of Excel's
//          "Insert Function -> Function Arguments" flow, owned by whichever
//          extension owns the domain the arguments come from.
// CONTEXT: Inversion of Control, the same shape as cellEditors.ts (an extension
//          hands over a React component; the shell renders it) and
//          controlsService.ts (one narrow contract, registered at activation).
//
// WHY THIS EXISTS AT ALL.
// The `fx` dialog can insert any function in the catalog, but all it can offer
// is the NAME and the SIGNATURE: it reads `get_all_functions` and knows nothing
// about the workbook's data. For nearly every function that is enough, because
// the arguments are cell references and numbers the user can see on the grid.
//
// It is not enough for a function whose arguments are a DOMAIN-SPECIFIC STRING
// that only some other subsystem can validate. `CUBEVALUE` is the worked
// example: its arguments are a BI connection NAME plus member expressions in
// Calcula's own syntax (`[Revenue]`, `Sales[country]=USA`, `{a,b}`), and a
// member expression that is merely MISSPELLED produces a silent `#N/A` — the
// pre-pass and the evaluator compute different lookup keys and neither of them
// is wrong enough to raise an error. Typing those by hand needs the live model:
// its measures, its tables and columns, the distinct values in a column, its
// KPIs. The BI extension has all of that; `@api` and the shell must never.
//
// WHY A SEAM RATHER THAN THE MENU COMMAND IT REPLACES.
// The builder used to hang off its own "Insert CUBE Formula..." item in the
// Formulas menu, which made CUBE the only function in the product with a
// private front door — discoverable only if you already knew it existed, and
// invisible from the `fx` button where a user actually goes looking for a
// function. Routing it through `fx` puts every function behind one entry point;
// the seam is what lets that happen without the shell importing an extension.
//
// WHAT THE BUILDER DOES *NOT* OWN: THE INSERT.
// A builder reports the formula it has assembled and nothing else. The host
// owns the Insert button and the commit, because a formula must land in the
// cell through the ONE path that runs the commit guards, the R1C1 rewrite and
// the grouped-sheet replication. The old dialog called `updateCell` itself and
// skipped all three. A builder that writes to the grid is a second commit path,
// and a second commit path drifts.

import React from "react";

// ============================================================================
// The contract
// ============================================================================

/** Where the formula is going, and which function the user picked. */
export interface FunctionBuilderContext {
  /** The catalog name of the function being built, always UPPER CASE. */
  functionName: string;
  /** Row of the cell the finished formula will be written to (0-based). */
  row: number;
  /** Column of the cell the finished formula will be written to (0-based). */
  col: number;
}

/** Props the host passes to a registered builder component. */
export interface FunctionBuilderProps {
  /** Which function, and where it is going. */
  context: FunctionBuilderContext;
  /**
   * Report the COMPLETE formula, leading `=` included, or `null` while the
   * spec is still too incomplete to form one.
   *
   * The host treats `null` as "Insert stays disabled". Call it on every change
   * — the host renders the preview and the button state from it, and never
   * inspects the builder's own state.
   */
  onFormulaChange: (formula: string | null) => void;
  /**
   * Ask the host to insert right now (a double-click, an Enter inside the
   * builder). The host re-checks the last reported formula first, so calling
   * this while incomplete is a no-op rather than an error.
   */
  onSubmit: () => void;
}

/** One registered builder. */
export interface FunctionBuilderRegistration {
  /** Unique id, for diagnostics and for replacing a registration. */
  id: string;
  /**
   * Catalog function names this builder handles. Case-insensitive on
   * registration — they are normalized to upper case, which is how the
   * catalog spells them and how the host looks them up.
   */
  functions: string[];
  /** Rendered by the host in place of the function-details panel. */
  component: React.ComponentType<FunctionBuilderProps>;
}

// ============================================================================
// Registry
// ============================================================================

/** Keyed by UPPER-CASE function name — the lookup the host performs. */
const builders = new Map<string, FunctionBuilderRegistration>();
type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/**
 * Register a builder for one or more functions. Called by an extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins for a given function name. Unregistering only clears
 * the names still pointing at THIS registration, so a re-activation followed by
 * the old cleanup running cannot blank out the live builder.
 */
export function registerFunctionBuilder(
  registration: FunctionBuilderRegistration,
): () => void {
  const names = registration.functions.map((n) => n.toUpperCase());
  const normalized: FunctionBuilderRegistration = { ...registration, functions: names };
  for (const name of names) {
    builders.set(name, normalized);
  }
  notifyChanged();

  return () => {
    let removed = false;
    for (const name of names) {
      if (builders.get(name) === normalized) {
        builders.delete(name);
        removed = true;
      }
    }
    if (removed) notifyChanged();
  };
}

/**
 * The builder for a function, or null when it has none.
 *
 * Null is the ordinary answer: almost every function in the catalog is inserted
 * as a template and completed on the grid. It is also the answer when the
 * owning extension is disabled, and the host must degrade to the template path
 * rather than refuse — a disabled BI extension should cost the user the guided
 * builder, not the ability to type `=CUBEVALUE(` at all.
 */
export function findFunctionBuilder(
  functionName: string,
): FunctionBuilderRegistration | null {
  return builders.get(functionName.toUpperCase()) ?? null;
}

/** Whether a function has a guided builder — for affordances, not for routing. */
export function hasFunctionBuilder(functionName: string): boolean {
  return builders.has(functionName.toUpperCase());
}

/**
 * Subscribe to registry changes.
 *
 * Needed because extensions activate AFTER the shell mounts: a dialog that read
 * the registry once at mount would show the plain signature panel for the whole
 * session if the user opened `fx` early enough.
 */
export function subscribeToFunctionBuilders(callback: ChangeListener): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function notifyChanged(): void {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("[FunctionBuilders] Error in change listener:", e);
    }
  });
}

/** Test/reset hook: forget every registered builder. */
export function resetFunctionBuilders(): void {
  builders.clear();
  notifyChanged();
}
