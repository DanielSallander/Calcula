//! FILENAME: app/src/api/floatingRangeService.ts
// PURPOSE: The feature-neutral seam through which any extension — or the script
//          broker — can enumerate, CREATE, resize, rename, write and DELETE
//          floating ranges without knowing a FloatingRange extension exists.
// CONTEXT: Inversion of Control, the exact shape controlsService.ts uses. The
//          FloatingRange extension OWNS floating ranges: the frontend row store
//          the canvas renders from, the overlay hit-test regions, the local
//          selection/editor state, and the region sync that makes an object
//          actually appear. @api owns nothing about them except this contract.
//
// WHY A SEAM RATHER THAN DIRECT BACKEND CALLS (the Seam Rule): the backend
// create command succeeds without ANYTHING appearing on the grid — nothing
// paints until the extension's store holds the row and the overlay regions are
// re-synced, and nothing repaints on a cell write until the extension's cell
// cache is invalidated. A caller that invokes the Rust commands itself gets a
// successful response and an invisible object — the exact defect class the
// controlsService header documents. Callers say WHAT they want; the owning
// extension decides HOW (store registration, region sync, cache invalidation,
// selection, redraw).

import type { FloatingRangeInfo } from "./floatingRanges";
import type { TypedCellData } from "../core/types";

// ============================================================================
// Requests
// ============================================================================

/** What a caller may ASK for when creating a floating range. Everything else —
 *  auto-naming ("Float1", …, in the shared sheet namespace), cascade placement,
 *  store registration, region sync — is the provider's business. */
export interface CreateFloatingRangeRequest {
  /** Explicit name; omitted auto-mints the next free "Float{n}". */
  name?: string;
  /** Sheet-pixel position on the ACTIVE sheet; omitted = viewport-visible cascade. */
  x?: number;
  y?: number;
  /** Visible window; omitted = 1x1. Bounds 1..1000 rows / 1..256 cols. */
  rows?: number;
  cols?: number;
}

// ============================================================================
// Provider
// ============================================================================

/**
 * What the FloatingRange extension provides.
 *
 * Everything is id-addressed (EntityId uuid) — the id every other surface
 * carries. `list` is synchronous from the extension's loaded store, so an
 * enumeration never races an IPC round trip.
 *
 * Undo semantics callers may state in their own descriptions: create keeps
 * history; resize / setCells are undoable; rename and delete END the history.
 */
export interface FloatingRangeProvider {
  /** Every floating range in the workbook (all sheets), from the live store. */
  list(): FloatingRangeInfo[];

  /** Create a real, visible floating range on the active sheet. */
  create(request: CreateFloatingRangeRequest): Promise<FloatingRangeInfo>;

  /** Change the visible window (grow keeps content; shrink hides, never deletes). */
  resize(id: string, rows: number, cols: number): Promise<FloatingRangeInfo>;

  /** Rename (shared sheet namespace; formulas repaired; ENDS undo history). */
  rename(id: string, name: string): Promise<FloatingRangeInfo>;

  /** Delete the object + backing cells (refs become #REF!; ENDS undo history). */
  delete(id: string): Promise<void>;

  /** Typed sparse read of a rectangle of FR cells (get_range_cells_typed shape). */
  getCells(
    id: string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<TypedCellData[]>;

  /** Write a rectangle of values/formulas starting at (startRow, startCol).
   *  Strings starting with "=" are formulas; "" clears a cell. Undoable. */
  setCells(
    id: string,
    startRow: number,
    startCol: number,
    values: string[][],
  ): Promise<void>;
}

let provider: FloatingRangeProvider | null = null;

/**
 * Register the floating-range driver. Called once by the FloatingRange
 * extension at activation; returns the unregister function for its cleanup
 * list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation followed by the OLD
 * cleanup running cannot blank out the live provider.
 */
export function registerFloatingRangeProvider(
  next: FloatingRangeProvider,
): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether floating ranges can currently be enumerated or mutated. */
export function hasFloatingRangeProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider, or null.
 *
 * For ENUMERATION/READS only, where "the FloatingRange extension is not
 * loaded" and "this workbook has no floating ranges" are the same answer and
 * an empty list is honest. Every MUTATION must go through
 * `requireFloatingRangeProvider()`.
 */
export function getFloatingRangeProvider(): FloatingRangeProvider | null {
  return provider;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the FloatingRange extension is disabled or
 * failed to load). Refusing loudly is the point: the silent alternative is a
 * successful backend response and no object on the grid.
 */
export function requireFloatingRangeProvider(): FloatingRangeProvider {
  if (!provider) {
    throw new Error(
      "Floating ranges are unavailable: no floating-range provider is registered (the FloatingRange extension is not loaded). Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetFloatingRangeProvider(): void {
  provider = null;
}
