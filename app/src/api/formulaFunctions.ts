//! FILENAME: app/src/api/formulaFunctions.ts
// PURPOSE: Registry for custom worksheet functions registered by extensions.
// CONTEXT: Extensions call formulas.registerFunction() to add custom functions.
//          The FormulaAutocomplete extension merges these into the function catalog.
//          NOTE: Custom functions currently appear in autocomplete and are registered
//          as metadata. Actual evaluation requires a Rust<->TS callback bridge
//          (future work). For now, custom functions that are purely metadata/display
//          will show in autocomplete, and those with implementations can be called
//          by other TypeScript code.

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
   * The function implementation.
   * Receives evaluated argument values and returns a result.
   * NOTE: This is currently called only from TypeScript-side code.
   * Full Rust evaluator integration is planned for a future release.
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
