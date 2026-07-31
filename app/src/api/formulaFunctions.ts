//! FILENAME: app/src/api/formulaFunctions.ts
// PURPOSE: Registry for custom worksheet functions registered by extensions,
//          plus the two value contracts a UDF author needs: the VOLATILE flag
//          (when does the cell recalculate?) and the cell-error sentinel (how
//          do I return #N/A instead of the text "#N/A"?).
// CONTEXT: Extensions call formulas.registerFunction() to add custom functions.
//          The FormulaAutocomplete extension merges these into the function
//          catalog; formulaUdf.ts turns a registration into something the
//          worksheet evaluator can actually serve (see that module's header).
//          This file is a LEAF — it imports nothing, so both the evaluation
//          bridge (formulaUdf.ts) and the sandboxed library generator
//          (customFunctions.ts) can share the sentinel contract from here.

// ============================================================================
// Cell-error returns (VBA's CVErr(xlErrNA), without the VBA)
// ----------------------------------------------------------------------------
// A UDF returning the STRING "#N/A" must stay text — a function that formats
// error codes for a report would otherwise be unable to emit one. So an
// explicit error return is a sentinel OBJECT (structured-clone safe, therefore
// it survives the Worker boundary that user-authored bodies run behind):
//
//     return { __calculaError: "#N/A" };     // or cellError("#N/A")
//
// Throwing is also honoured: `throw new Error("#N/A")` and any thrown value
// carrying `__calculaError` map to the same cell error. Everything else that
// throws stays #VALUE! (a bug in the body is not a meaningful error value).
// ============================================================================

/** Property name that marks a UDF return value as an explicit cell error. */
export const UDF_ERROR_KEY = "__calculaError";

/**
 * The cell-error literals the engine can represent. Anything else a UDF names
 * degrades to #VALUE! — matching `parse_cell_error` in scripting/udf.rs, which
 * is the authority on the wire. (Excel's #NUM!/#NULL! have no engine variant,
 * so they are deliberately absent rather than silently aliased.)
 */
export const CELL_ERROR_LITERALS = [
  "#DIV/0!",
  "#REF!",
  "#NAME?",
  "#VALUE!",
  "#N/A",
  "#CIRCULAR!",
  "#CONFLICT",
  "#BLOCKED!",
] as const;

export type CellErrorLiteral = (typeof CELL_ERROR_LITERALS)[number];

const CELL_ERROR_SET: ReadonlySet<string> = new Set<string>(CELL_ERROR_LITERALS);

/** A UDF return value that means "this cell is the error `code`". */
export interface UdfCellErrorSentinel {
  __calculaError: string;
}

/**
 * Canonicalize an error literal: trimmed + uppercased, with anything the
 * engine cannot represent collapsing to "#VALUE!" (never silently dropped).
 */
export function normalizeCellErrorLiteral(code: unknown): CellErrorLiteral {
  if (typeof code !== "string") return "#VALUE!";
  const up = code.trim().toUpperCase();
  return CELL_ERROR_SET.has(up) ? (up as CellErrorLiteral) : "#VALUE!";
}

/**
 * Build the sentinel a UDF returns to put a specific error in the cell:
 * `return cellError("#N/A")`. Extension-authored UDFs can import this; bodies
 * written in the Custom Functions dialog get the same helper injected into
 * their sandbox scope (customFunctions.ts).
 */
export function cellError(code: string): UdfCellErrorSentinel {
  return { [UDF_ERROR_KEY]: normalizeCellErrorLiteral(code) } as UdfCellErrorSentinel;
}

/**
 * The error literal carried by a RETURNED value, or null. Only the sentinel
 * object counts here: a UDF returning the plain string "#N/A" must stay TEXT
 * (Excel parity — in VBA only CVErr produces an error, a String stays a
 * string), otherwise a function that formats error codes for a report could
 * never emit one.
 */
export function asCellErrorSentinel(x: unknown): CellErrorLiteral | null {
  if (x && typeof x === "object" && UDF_ERROR_KEY in (x as Record<string, unknown>)) {
    return normalizeCellErrorLiteral((x as Record<string, unknown>)[UDF_ERROR_KEY]);
  }
  return null;
}

/**
 * The error literal carried by a THROWN value, or null. Accepts the sentinel
 * object (`throw cellError("#N/A")`) and an Error/string whose message is
 * exactly a literal (`throw new Error("#N/A")`) — the latter is the form that
 * survives the sandbox worker's `{ message }`-only error channel, so it is the
 * only way a sandboxed body can throw a specific error. Anything else is a
 * genuine bug in the body and stays #VALUE!.
 */
export function thrownCellErrorLiteral(e: unknown): CellErrorLiteral | null {
  const sentinel = asCellErrorSentinel(e);
  if (sentinel !== null) return sentinel;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : null;
  if (message === null) return null;
  const up = message.trim().toUpperCase();
  return CELL_ERROR_SET.has(up) ? (up as CellErrorLiteral) : null;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Definition for a custom worksheet function registered by an extension.
 */
export interface CustomFunctionDef {
  /** Function name (will be uppercased for matching). */
  name: string;
  /** Brief description of what the function does. */
  description: string;
  /** Syntax string for display (e.g., "MYFUNCTION(arg1, arg2)"). */
  syntax: string;
  /** Category for grouping (e.g., "Financial", "Custom", "Statistics"). */
  category: string;
  /** Minimum number of arguments required. */
  minArgs: number;
  /** Maximum number of arguments accepted (-1 for unlimited). */
  maxArgs: number;
  /**
   * Recalculate every edit, like Excel's `Application.Volatile` (default
   * false = recalculate only when an argument changes).
   *
   * Non-volatile is the right default and the reason this flag exists: the
   * pre-fetch used to re-evaluate EVERY UDF-mentioning formula cell in the
   * workbook on every keystroke-commit. It now only visits the cells the edit
   * can actually reach — unless the function is volatile, in which case its
   * cells are pre-resolved AND spliced into the recalc order so they really do
   * recompute (NOW()-style clocks, RAND()-style samplers, anything reading
   * outside the grid).
   */
  volatile?: boolean;
  /**
   * The function implementation.
   * Receives evaluated argument values and returns a result. Return
   * `cellError("#N/A")` (or `{ __calculaError: "#N/A" }`) for an explicit cell
   * error; return an array to spill like a native dynamic array.
   */
  implementation: (...args: unknown[]) => unknown;
}

// ============================================================================
// Registry (module-level singleton)
// ============================================================================

const registry = new Map<string, CustomFunctionDef>();
const listeners = new Set<() => void>();

/**
 * Notify all subscribers that the registry has changed.
 */
function notifyChange(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (error) {
      console.error("[FormulaFunctions] Error in change listener:", error);
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a custom worksheet function.
 * @param def The function definition including name, metadata, and implementation.
 * @returns An unregister function that removes the custom function.
 */
export function registerFunction(def: CustomFunctionDef): () => void {
  const key = def.name.toUpperCase();

  if (registry.has(key)) {
    console.warn(
      `[FormulaFunctions] Function '${def.name}' is already registered. Overwriting.`
    );
  }

  // Store with uppercased name for consistency
  const storedDef: CustomFunctionDef = {
    ...def,
    name: def.name.toUpperCase(),
  };
  registry.set(key, storedDef);

  console.log(`[FormulaFunctions] Registered custom function: ${key}`);
  notifyChange();

  // Return unregister function
  return () => {
    if (registry.get(key) === storedDef) {
      registry.delete(key);
      console.log(`[FormulaFunctions] Unregistered custom function: ${key}`);
      notifyChange();
    }
  };
}

/**
 * Look up a custom function by name (case-insensitive).
 */
export function getCustomFunction(name: string): CustomFunctionDef | undefined {
  return registry.get(name.toUpperCase());
}

/**
 * Get all registered custom functions.
 */
export function getAllCustomFunctions(): CustomFunctionDef[] {
  return Array.from(registry.values());
}

/**
 * Uppercased names of the registered functions marked volatile. Read by the
 * UDF pre-fetch to decide which cells recalculate on every edit regardless of
 * dependencies.
 */
export function getVolatileCustomFunctionNames(): string[] {
  const names: string[] = [];
  for (const def of registry.values()) {
    if (def.volatile) names.push(def.name);
  }
  return names;
}

/**
 * Check if a custom function is registered (case-insensitive).
 */
export function hasCustomFunction(name: string): boolean {
  return registry.has(name.toUpperCase());
}

/**
 * Execute a custom function by name with the given arguments.
 * Returns undefined if the function is not registered.
 * Throws if the function's implementation throws.
 */
export function executeCustomFunction(
  name: string,
  ...args: unknown[]
): unknown {
  const def = registry.get(name.toUpperCase());
  if (!def) {
    return undefined;
  }

  // Validate argument count
  if (args.length < def.minArgs) {
    throw new Error(
      `${def.name} requires at least ${def.minArgs} argument(s), got ${args.length}`
    );
  }
  if (def.maxArgs >= 0 && args.length > def.maxArgs) {
    throw new Error(
      `${def.name} accepts at most ${def.maxArgs} argument(s), got ${args.length}`
    );
  }

  return def.implementation(...args);
}

/**
 * Subscribe to changes in the custom function registry.
 * @param callback Called whenever functions are added or removed.
 * @returns Unsubscribe function.
 */
export function subscribeToCustomFunctions(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Get the count of registered custom functions.
 */
export function getCustomFunctionCount(): number {
  return registry.size;
}
