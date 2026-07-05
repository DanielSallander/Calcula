//! FILENAME: app/src/api/cellTypes.ts
// PURPOSE: Cell Type registry — the per-cell composition brick (granular bricks).
// CONTEXT: A cell type bundles rendering + editing + interaction + validation
//          into ONE registrable unit (checkbox, progress bar, button, ...).
//          Individual cells are tagged with a typeId + params; assignments are
//          stored backend-side (undoable, persisted, shifted by structural
//          edits — see app/src-tauri/src/cell_types.rs). This module owns the
//          type DEFINITIONS and a per-active-sheet assignment index that the
//          Core render/interaction paths consult in O(1).
// ARCHITECTURE: API layer. The Core calls the hot-path hooks below
//          (renderCellTypeCell / getCellTypeAt / handleCellTypeKeyDown); all
//          other behavior fans out through the EXISTING registries (click
//          interceptors, cursor interceptors, edit guards, commit guards) via
//          single internal registrations — no new Core coupling.
// PERFORMANCE CONTRACT (paint path): hasCellTypes() is a size check;
//          getCellTypeAt is one Map.get with a numeric key (no allocation);
//          renderCellTypeCell does one lookup + the type's own draw inside a
//          save/clip/restore. Type render functions MUST be O(1) per cell,
//          allocation-light, and must never do I/O.

import { invoke } from "@tauri-apps/api/core";
import type { CellDecorationContext } from "./cellDecorations";
import {
  registerCellClickInterceptor,
  registerCellCursorInterceptor,
  type CellClickEvent,
} from "../core/lib/cellClickInterceptors";
import { registerEditGuard } from "../core/lib/editGuards";
import { registerCommitGuard } from "../core/lib/commitGuards";
import { AppEvents, emitAppEvent, onAppEvent } from "./events";

// ============================================================================
// Types
// ============================================================================

/** Context passed to a cell type's render function. The canvas is clipped to
 *  the cell bounds and wrapped in save/restore by the caller. */
export interface CellTypeRenderContext extends CellDecorationContext {
  /** The assignment's type id. */
  typeId: string;
  /** The assignment's params (type-defined shape, e.g. { max: 100 }). */
  params: Record<string, unknown>;
  /** Raw display value of the cell ("" when the cell is empty). */
  value: string;
  /** Whether the cell holds a formula (render read-only affordances). */
  hasFormula: boolean;
}

/** Context passed to a cell type's onClick handler. */
export interface CellTypeClickContext {
  row: number;
  col: number;
  typeId: string;
  params: Record<string, unknown>;
  event: CellClickEvent;
}

/** Context passed to a cell type's onKeyDown handler. */
export interface CellTypeKeyContext {
  row: number;
  col: number;
  typeId: string;
  params: Record<string, unknown>;
  key: string;
}

/**
 * A cell type definition — one brick composing rendering, editing,
 * interaction and validation for cells tagged with this type.
 */
export interface CellTypeDefinition {
  /** Unique id, namespaced (e.g. "calcula.checkbox"). */
  id: string;
  /**
   * Draw the cell content. Return `true` when the type fully handled the
   * content (Core skips the default text pass); return `false`/void to fall
   * through to normal text rendering (the value stays visible).
   */
  render: (ctx: CellTypeRenderContext) => boolean | void;
  /**
   * Editing behavior: "default" = normal inline editor (typing/F2 work,
   * commit runs coerce/validate); "none" = the cell cannot enter edit mode
   * from user gestures (scripts/backend still write values). Default: "default".
   */
  editor?: "none" | "default";
  /**
   * Single-click handler (fires only for cells tagged with this type, before
   * default selection). Return `true` to claim the click. All value changes
   * must go through normal @api writes so they stay undoable.
   */
  onClick?: (ctx: CellTypeClickContext) => boolean | Promise<boolean>;
  /**
   * Keyboard handler for the selected (non-editing) cell. v1: invoked for
   * Space only. Return `true` when handled.
   */
  onKeyDown?: (ctx: CellTypeKeyContext) => boolean | Promise<boolean>;
  /**
   * Commit-time coercion: return the replacement string (e.g. "yes" -> "TRUE")
   * or null to keep the value as typed. Runs before validate.
   */
  coerce?: (value: string, params: Record<string, unknown>) => string | null;
  /**
   * Commit-time validation: return "block" to cancel the commit, "retry" to
   * keep the editor open for correction, or null to allow.
   */
  validate?: (value: string, params: Record<string, unknown>) => "block" | "retry" | null;
  /** CSS cursor when hovering a cell of this type (null = default). */
  getCursor?: (params: Record<string, unknown>) => string | null;
  /**
   * What the formula bar / clipboard text should show for this cell (defaults
   * to the raw value). Informational in v1.
   */
  displayText?: (value: string, params: Record<string, unknown>) => string;
}

/** A cell's assignment as exposed to callers. */
export interface CellTypeAssignment {
  typeId: string;
  params: Record<string, unknown>;
}

/** Backend entry shape (mirrors Rust CellTypeEntry). */
interface CellTypeEntry {
  sheetIndex: number;
  row: number;
  col: number;
  typeId: string;
  params: Record<string, unknown> | null;
}

/** The registry surface handed to extensions via ExtensionContext.grid.cellTypes. */
export interface ICellTypeAPI {
  register(def: CellTypeDefinition): () => void;
  unregister(id: string): void;
  setCellType(
    row: number,
    col: number,
    typeId: string,
    params?: Record<string, unknown>
  ): Promise<void>;
  setCellTypeRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    typeId: string,
    params?: Record<string, unknown>
  ): Promise<number>;
  clearCellType(row: number, col: number): Promise<void>;
  clearCellTypeRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number
  ): Promise<number>;
  getCellTypeAt(row: number, col: number): CellTypeAssignment | null;
  refresh(): Promise<void>;
}

// ============================================================================
// Internal State
// ============================================================================

interface ResolvedAssignment {
  typeId: string;
  params: Record<string, unknown>;
  /** Pre-resolved definition (null = type id not registered -> fallback). */
  def: CellTypeDefinition | null;
}

const typeRegistry = new Map<string, CellTypeDefinition>();

/** Assignment index for the ACTIVE sheet. Key = row * COL_KEY_SPAN + col. */
const assignmentIndex = new Map<number, ResolvedAssignment>();

/** Numeric-key span: supports cols < 65536 and rows < 2^37 loss-free. */
const COL_KEY_SPAN = 65536;

function indexKey(row: number, col: number): number {
  return row * COL_KEY_SPAN + col;
}

/** Guards against out-of-order refresh responses (rapid sheet switches). */
let refreshSeq = 0;

let initialized = false;

// ============================================================================
// Hot-path hooks (called by the Core render/interaction pipelines)
// ============================================================================

/**
 * True when any cell on the active sheet has a type assignment. The renderer
 * uses this to skip the cell-type path entirely on untyped workbooks.
 */
export function hasCellTypes(): boolean {
  return assignmentIndex.size > 0;
}

/** O(1) assignment lookup for a cell on the active sheet. */
export function getCellTypeAt(row: number, col: number): CellTypeAssignment | null {
  const a = assignmentIndex.get(indexKey(row, col));
  return a ? { typeId: a.typeId, params: a.params } : null;
}

/**
 * Render hook called by both Core draw paths (main + freeze/split zones)
 * after cell decorations and before the text pass.
 *
 * Returns `true` when the cell's type fully handled content rendering (the
 * caller skips the default text pass). Unregistered type ids degrade to a
 * small corner badge + `false` so the raw value stays visible and nothing
 * is hidden.
 */
export function renderCellTypeCell(
  context: CellDecorationContext & { hasFormula?: boolean }
): boolean {
  const a = assignmentIndex.get(indexKey(context.row, context.col));
  if (!a) return false;

  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;

  if (!a.def) {
    // Fallback: type not registered (extension missing/disabled). Keep the
    // cell fully functional and visibly mark that a dormant assignment exists.
    ctx.save();
    ctx.beginPath();
    ctx.rect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
    ctx.clip();
    ctx.fillStyle = "rgba(128, 128, 128, 0.35)";
    ctx.beginPath();
    ctx.moveTo(cellRight - 7, cellTop);
    ctx.lineTo(cellRight, cellTop);
    ctx.lineTo(cellRight, cellTop + 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return false;
  }

  let handled = false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellLeft, cellTop, cellRight - cellLeft, cellBottom - cellTop);
  ctx.clip();
  try {
    handled =
      a.def.render({
        ...context,
        typeId: a.typeId,
        params: a.params,
        value: context.display,
        hasFormula: context.hasFormula === true,
      }) === true;
  } catch (error) {
    console.error(`[CellTypes] Error rendering type "${a.typeId}":`, error);
  }
  ctx.restore();
  return handled;
}

/**
 * Keyboard hook consulted by the Core's grid keyboard handling for the
 * selected (non-editing) cell. v1: Space only. Returns whether handled.
 */
export async function handleCellTypeKeyDown(
  row: number,
  col: number,
  key: string
): Promise<boolean> {
  const a = assignmentIndex.get(indexKey(row, col));
  if (!a?.def?.onKeyDown) return false;
  try {
    return (
      (await a.def.onKeyDown({ row, col, typeId: a.typeId, params: a.params, key })) === true
    );
  } catch (error) {
    console.error(`[CellTypes] Error in onKeyDown of type "${a.typeId}":`, error);
    return false;
  }
}

// ============================================================================
// Internal fan-out registrations (existing Core registries)
// ============================================================================

function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  // Click: claim only when the cell has a typed onClick that handles it.
  registerCellClickInterceptor(async (row, col, event) => {
    const a = assignmentIndex.get(indexKey(row, col));
    if (!a?.def?.onClick) return false;
    try {
      return (
        (await a.def.onClick({ row, col, typeId: a.typeId, params: a.params, event })) === true
      );
    } catch (error) {
      console.error(`[CellTypes] Error in onClick of type "${a.typeId}":`, error);
      return false;
    }
  });

  // Cursor: per-type override (e.g. pointer over buttons/checkboxes).
  registerCellCursorInterceptor((row, col) => {
    const a = assignmentIndex.get(indexKey(row, col));
    if (!a?.def?.getCursor) return null;
    try {
      return a.def.getCursor(a.params);
    } catch {
      return null;
    }
  });

  // Edit guard: types with editor:"none" never enter edit mode from gestures.
  registerEditGuard(async (row, col) => {
    const a = assignmentIndex.get(indexKey(row, col));
    if (a?.def?.editor === "none") {
      return { blocked: true };
    }
    return null;
  });

  // Commit guard: coerce, then validate, for typed cells edited normally.
  registerCommitGuard(async (row, col, value) => {
    const a = assignmentIndex.get(indexKey(row, col));
    if (!a?.def) return null;
    let current = value;
    if (a.def.coerce) {
      try {
        const coerced = a.def.coerce(current, a.params);
        if (typeof coerced === "string") current = coerced;
      } catch (error) {
        console.error(`[CellTypes] Error in coerce of type "${a.typeId}":`, error);
      }
    }
    if (a.def.validate) {
      try {
        const verdict = a.def.validate(current, a.params);
        if (verdict === "block" || verdict === "retry") {
          return { action: verdict };
        }
      } catch (error) {
        console.error(`[CellTypes] Error in validate of type "${a.typeId}":`, error);
      }
    }
    return current !== value ? { action: "allow", newValue: current } : null;
  });

  // Assignment index lifecycle: the index mirrors the ACTIVE sheet's backend
  // store. Any event that can change assignments or the active sheet re-pulls.
  const refreshEvents = [
    AppEvents.SHEET_CHANGED,
    AppEvents.AFTER_OPEN,
    AppEvents.AFTER_NEW,
    AppEvents.ROWS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.COLUMNS_DELETED,
  ];
  for (const eventName of refreshEvents) {
    onAppEvent(eventName, () => {
      void refreshCellTypeAssignments();
    });
  }
  // Undo/redo of assignment changes lands in the "objects" mutation domain.
  onAppEvent(AppEvents.MUTATION_REFRESH, (payload: { domains?: string[] } | undefined) => {
    if (!payload?.domains || payload.domains.includes("objects")) {
      void refreshCellTypeAssignments();
    }
  });
}

// ============================================================================
// Backend sync
// ============================================================================

function resolve(entry: { typeId: string; params: Record<string, unknown> | null }): ResolvedAssignment {
  return {
    typeId: entry.typeId,
    params: entry.params ?? {},
    def: typeRegistry.get(entry.typeId) ?? null,
  };
}

/** Re-resolve defs for existing assignments (after register/unregister). */
function reresolveIndex(): void {
  for (const a of assignmentIndex.values()) {
    a.def = typeRegistry.get(a.typeId) ?? null;
  }
}

/**
 * Re-pull the active sheet's assignments from the backend and rebuild the
 * index. Safe to call at any time; out-of-order responses are dropped.
 */
export async function refreshCellTypeAssignments(): Promise<void> {
  ensureInit();
  const seq = ++refreshSeq;
  try {
    // sheetIndex omitted -> backend resolves its OWN active sheet, so the
    // index can never disagree with what the grid is about to paint.
    const entries = await invoke<CellTypeEntry[]>("get_all_cell_types", {});
    if (seq !== refreshSeq) return;
    assignmentIndex.clear();
    for (const e of entries) {
      assignmentIndex.set(indexKey(e.row, e.col), resolve(e));
    }
    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (error) {
    console.error("[CellTypes] Failed to refresh assignments:", error);
  }
}

// ============================================================================
// Registry + assignment API
// ============================================================================

/**
 * Register a cell type definition. Existing assignments referencing this id
 * activate immediately (they were rendering as fallback until now).
 * @returns Cleanup function that unregisters the type.
 */
export function registerCellType(def: CellTypeDefinition): () => void {
  ensureInit();
  typeRegistry.set(def.id, def);
  reresolveIndex();
  if (assignmentIndex.size > 0) emitAppEvent(AppEvents.GRID_REFRESH);
  return () => unregisterCellType(def.id);
}

/** Unregister a cell type. Assigned cells degrade to the fallback badge. */
export function unregisterCellType(id: string): void {
  if (typeRegistry.delete(id)) {
    reresolveIndex();
    if (assignmentIndex.size > 0) emitAppEvent(AppEvents.GRID_REFRESH);
  }
}

/** Look up a registered definition (null when absent). */
export function getCellTypeDefinition(id: string): CellTypeDefinition | null {
  return typeRegistry.get(id) ?? null;
}

/** Assign a type to one cell on the active sheet (undoable). */
export async function setCellType(
  row: number,
  col: number,
  typeId: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  ensureInit();
  await invoke("set_cell_type", { row, col, typeId, params });
  assignmentIndex.set(indexKey(row, col), resolve({ typeId, params }));
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Assign a type to every cell in a range on the active sheet (one undo step). */
export async function setCellTypeRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  typeId: string,
  params: Record<string, unknown> = {}
): Promise<number> {
  ensureInit();
  const count = await invoke<number>("set_cell_type_range", {
    startRow,
    startCol,
    endRow,
    endCol,
    typeId,
    params,
  });
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      assignmentIndex.set(indexKey(r, c), resolve({ typeId, params }));
    }
  }
  emitAppEvent(AppEvents.GRID_REFRESH);
  return count;
}

/** Clear one cell's type assignment on the active sheet (undoable). */
export async function clearCellType(row: number, col: number): Promise<void> {
  await invoke("clear_cell_type", { row, col });
  assignmentIndex.delete(indexKey(row, col));
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Clear all assignments inside a range on the active sheet (one undo step). */
export async function clearCellTypeRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  const removed = await invoke<number>("clear_cell_type_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      assignmentIndex.delete(indexKey(r, c));
    }
  }
  emitAppEvent(AppEvents.GRID_REFRESH);
  return removed;
}

/** The ICellTypeAPI instance wired into ExtensionContext.grid.cellTypes. */
export const cellTypeAPI: ICellTypeAPI = {
  register: registerCellType,
  unregister: unregisterCellType,
  setCellType,
  setCellTypeRange,
  clearCellType,
  clearCellTypeRange,
  getCellTypeAt,
  refresh: refreshCellTypeAssignments,
};

// ============================================================================
// Test support
// ============================================================================

/** TEST-ONLY: reset all module state (registry, index, init flag stay clean
 *  between vitest cases; the fan-out registrations cannot be unregistered, so
 *  tests must not rely on interceptor counts). */
export function __resetCellTypesForTests(): void {
  typeRegistry.clear();
  assignmentIndex.clear();
  refreshSeq++;
}

/** TEST-ONLY: seed the assignment index without a backend round-trip. */
export function __seedAssignmentForTests(
  row: number,
  col: number,
  typeId: string,
  params: Record<string, unknown> = {}
): void {
  assignmentIndex.set(indexKey(row, col), resolve({ typeId, params }));
}
