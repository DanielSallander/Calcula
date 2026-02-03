//! FILENAME: app/src/api/styleInterceptors.ts
// PURPOSE: Style Interceptor Pipeline for dynamic cell styling
// CONTEXT: Allows extensions to modify cell styles at render time without
//          polluting the Core with feature-specific logic (e.g., Conditional Formatting).
// ARCHITECTURE: Part of the API layer - the bridge between Core and Extensions.

// ============================================================================
// Types
// ============================================================================

/** Style properties that an interceptor can override */
export interface IStyleOverride {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
}

/** Cell coordinates passed to interceptors */
export interface CellCoords {
  row: number;
  col: number;
  sheetIndex?: number;
}

/** Base style information passed to interceptors */
export interface BaseStyleInfo extends IStyleOverride {
  // Additional context the interceptor might need
  styleIndex: number;
}

/**
 * Style interceptor function signature.
 * Called during render for each visible cell.
 * 
 * @param cellValue - The display value of the cell
 * @param baseStyle - The current style (from styleCache or previous interceptors)
 * @param coords - The cell coordinates
 * @returns Style overrides to apply, or null/undefined to keep baseStyle unchanged
 */
export type StyleInterceptorFn = (
  cellValue: string,
  baseStyle: BaseStyleInfo,
  coords: CellCoords
) => IStyleOverride | null | undefined;

/** Interceptor registration with metadata */
export interface StyleInterceptorRegistration {
  id: string;
  interceptor: StyleInterceptorFn;
  /** Priority for execution order (lower = earlier). Default: 0 */
  priority?: number;
}

// ============================================================================
// Internal State
// ============================================================================

const interceptorRegistry = new Map<string, StyleInterceptorRegistration>();
let sortedInterceptors: StyleInterceptorRegistration[] = [];
let isDirty = true;

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a style interceptor.
 * Interceptors are called in priority order (lower priority = called first).
 * Each interceptor can modify the style, and changes accumulate.
 * 
 * @param id - Unique identifier for this interceptor
 * @param interceptor - The interceptor function
 * @param priority - Execution priority (lower = earlier). Default: 0
 * @returns Cleanup function to unregister the interceptor
 * 
 * @example
 * ```ts
 * // In conditional-formatting extension:
 * const cleanup = registerStyleInterceptor(
 *   "conditional-formatting",
 *   (cellValue, baseStyle, coords) => {
 *     if (Number(cellValue) > 100) {
 *       return { backgroundColor: "#ff0000", textColor: "#ffffff" };
 *     }
 *     return null; // No change
 *   },
 *   10 // Priority
 * );
 * ```
 */
export function registerStyleInterceptor(
  id: string,
  interceptor: StyleInterceptorFn,
  priority: number = 0
): () => void {
  const registration: StyleInterceptorRegistration = {
    id,
    interceptor,
    priority,
  };
  
  interceptorRegistry.set(id, registration);
  isDirty = true;
  
  return () => {
    unregisterStyleInterceptor(id);
  };
}

/**
 * Unregister a style interceptor by ID.
 */
export function unregisterStyleInterceptor(id: string): void {
  if (interceptorRegistry.delete(id)) {
    isDirty = true;
  }
}

/**
 * Get all registered interceptors, sorted by priority.
 * Uses internal caching for performance (hot path in render loop).
 */
export function getStyleInterceptors(): StyleInterceptorRegistration[] {
  if (isDirty) {
    sortedInterceptors = Array.from(interceptorRegistry.values()).sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
    );
    isDirty = false;
  }
  return sortedInterceptors;
}

/**
 * Check if any interceptors are registered.
 * Used by the renderer to skip the interceptor pipeline entirely when empty.
 */
export function hasStyleInterceptors(): boolean {
  return interceptorRegistry.size > 0;
}

/**
 * Apply all registered interceptors to a cell's style.
 * Called by the Core renderer for each visible cell.
 * 
 * @param cellValue - The display value of the cell
 * @param baseStyle - The base style from the style cache
 * @param coords - Cell coordinates
 * @returns The final style after all interceptors have been applied
 */
export function applyStyleInterceptors(
  cellValue: string,
  baseStyle: BaseStyleInfo,
  coords: CellCoords
): BaseStyleInfo {
  const interceptors = getStyleInterceptors();
  
  if (interceptors.length === 0) {
    return baseStyle;
  }
  
  // Start with a copy of baseStyle to accumulate changes
  let currentStyle: BaseStyleInfo = { ...baseStyle };
  
  for (const registration of interceptors) {
    try {
      const override = registration.interceptor(cellValue, currentStyle, coords);
      if (override) {
        // Merge override into currentStyle
        currentStyle = {
          ...currentStyle,
          ...override,
        };
      }
    } catch (error) {
      // Log but don't break rendering if an interceptor fails
      console.error(`[StyleInterceptor] Error in interceptor "${registration.id}":`, error);
    }
  }
  
  return currentStyle;
}

// ============================================================================
// Dirty Range Cache (Performance Optimization)
// ============================================================================

/** Range that needs re-evaluation */
export interface DirtyRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  sheetIndex?: number;
}

let dirtyRanges: DirtyRange[] = [];
let fullSheetDirty = false;

/**
 * Mark a range as dirty (needs style re-evaluation).
 * Called by extensions when their rules change or data changes.
 */
export function markRangeDirty(range: DirtyRange): void {
  dirtyRanges.push(range);
}

/**
 * Mark the entire sheet as dirty.
 */
export function markSheetDirty(): void {
  fullSheetDirty = true;
  dirtyRanges = [];
}

/**
 * Clear dirty state after render.
 */
export function clearDirtyState(): void {
  dirtyRanges = [];
  fullSheetDirty = false;
}

/**
 * Check if a cell is in a dirty range.
 */
export function isCellDirty(row: number, col: number, sheetIndex?: number): boolean {
  if (fullSheetDirty) {
    return true;
  }
  
  for (const range of dirtyRanges) {
    if (
      (range.sheetIndex === undefined || range.sheetIndex === sheetIndex) &&
      row >= range.startRow &&
      row <= range.endRow &&
      col >= range.startCol &&
      col <= range.endCol
    ) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if any dirty state exists.
 */
export function hasDirtyState(): boolean {
  return fullSheetDirty || dirtyRanges.length > 0;
}