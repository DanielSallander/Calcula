//! FILENAME: app/src/api/cellBehaviors.ts
// PURPOSE: Cell-behavior bindings — the script-tier per-cell brick (granular
//          bricks phase 2). A binding pairs a grid range with an object script
//          (objectType "range", instanceId = binding id) plus declarative
//          dispatch metadata (claimClick).
// CONTEXT: This module owns the frontend binding index (all sheets, spatially
//          indexed) and the ONE click/double-click interceptor pair that
//          dispatches grid gestures to behavior scripts. Dispatch is
//          fire-and-forget into the script's worker via app events
//          ("cellbehavior:clicked"/"cellbehavior:dblclicked") that the script
//          host forwards — the interceptor itself never waits on a worker.
// CONTRACT: Click-claim is BINDING METADATA (claimClick), never a handler
//          return value — handlers run asynchronously in a sandboxed worker,
//          so the claim decision must be available synchronously-fast here.

import { invoke } from "@tauri-apps/api/core";
import { registerCellClickInterceptor } from "../core/lib/cellClickInterceptors";
import { registerCellDoubleClickInterceptor } from "../core/lib/cellDoubleClickInterceptors";
import { getDesignMode } from "./designMode";
import { AppEvents, emitAppEvent, onAppEvent } from "./events";

// ============================================================================
// Types
// ============================================================================

/** A cell-behavior binding (mirrors Rust CellBehaviorBinding). */
export interface CellBehaviorBinding {
  /** Opaque UUID; doubles as the script's instanceId. */
  id: string;
  /** The object script (objectType "range") this binding dispatches to. */
  scriptId: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Whether a click on the target suppresses default selection handling. */
  claimClick: boolean;
  enabled: boolean;
  /** Set when a structural edit deleted the whole target (dispatch stops). */
  orphaned: boolean;
}

/** Payload of the "cellbehavior:clicked" / "cellbehavior:dblclicked" events. */
export interface CellBehaviorClickPayload {
  bindingId: string;
  scriptId: string;
  row: number;
  col: number;
  sheetIndex: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Emitted whenever the binding set changes (CRUD, undo, structural edits). */
export const CELL_BEHAVIORS_CHANGED_EVENT = "cellbehaviors:changed";

// ============================================================================
// Internal state — the binding index
// ============================================================================

const bindingsById = new Map<string, CellBehaviorBinding>();

/** Per-sheet spatial index: exact map for 1-cell targets + array for ranges. */
interface SheetIndex {
  singles: Map<number, CellBehaviorBinding>;
  ranges: CellBehaviorBinding[];
}

const bySheet = new Map<number, SheetIndex>();

const COL_KEY_SPAN = 65536;
function cellKey(row: number, col: number): number {
  return row * COL_KEY_SPAN + col;
}

let activeSheetIndex = 0;
let refreshSeq = 0;
let initialized = false;

function rebuildSpatialIndex(): void {
  bySheet.clear();
  for (const b of bindingsById.values()) {
    let idx = bySheet.get(b.sheetIndex);
    if (!idx) {
      idx = { singles: new Map(), ranges: [] };
      bySheet.set(b.sheetIndex, idx);
    }
    if (b.startRow === b.endRow && b.startCol === b.endCol) {
      idx.singles.set(cellKey(b.startRow, b.startCol), b);
    } else {
      idx.ranges.push(b);
    }
  }
}

// ============================================================================
// Lookups (sync — used by interceptors, the script host, and badges)
// ============================================================================

/** The binding covering (row, col) on a sheet, or null. Range targets are a
 *  linear bbox scan — O(bindings on that sheet), tiny in practice. */
export function getCellBehaviorAt(
  row: number,
  col: number,
  sheetIndex: number = activeSheetIndex
): CellBehaviorBinding | null {
  const idx = bySheet.get(sheetIndex);
  if (!idx) return null;
  const single = idx.singles.get(cellKey(row, col));
  if (single) return single;
  for (const b of idx.ranges) {
    if (row >= b.startRow && row <= b.endRow && col >= b.startCol && col <= b.endCol) {
      return b;
    }
  }
  return null;
}

/** A binding by id (the script host resolves instanceId -> target this way). */
export function getCellBehaviorById(id: string): CellBehaviorBinding | null {
  return bindingsById.get(id) ?? null;
}

/** All bindings (sorted by id), for panels/tests. */
export function listCellBehaviors(): CellBehaviorBinding[] {
  return [...bindingsById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether any binding exists on the active sheet (badge fast flag). */
export function hasCellBehaviors(): boolean {
  const idx = bySheet.get(activeSheetIndex);
  return !!idx && (idx.singles.size > 0 || idx.ranges.length > 0);
}

/** The active sheet index the interceptors dispatch against. */
export function activeBehaviorSheet(): number {
  return activeSheetIndex;
}

// ============================================================================
// Gesture dispatch (the ONE interceptor pair)
// ============================================================================

/**
 * Shared gesture gate: which binding (if any) should receive this gesture and
 * whether it claims the click. Fires the app event the host forwards into the
 * script's worker; returns the claim verdict for the interceptor.
 */
async function dispatchGesture(
  eventName: "cellbehavior:clicked" | "cellbehavior:dblclicked",
  row: number,
  col: number,
  event: { clientX: number; clientY: number; ctrlKey?: boolean; metaKey?: boolean }
): Promise<boolean> {
  const b = getCellBehaviorAt(row, col);
  if (!b || !b.enabled || b.orphaned) return false;
  // Design mode: gestures select/edit, behaviors fire in run mode only.
  if (getDesignMode()) return false;
  // A behavior whose script is not mounted (script security off, missing
  // script, faulted worker) must not swallow clicks — nothing would happen,
  // which is a transparency failure.
  const { ObjectScriptManager } = await import("./scriptableObjects");
  if (!ObjectScriptManager.isScriptMounted(b.scriptId)) return false;
  // Hook-declared gate: a binding only receives (and can only claim) gestures
  // its script actually handles — an onChange-only behavior must not swallow
  // clicks or block selection.
  const { mountedScriptHasHook } = await import("./scriptHost/host");
  const hookName = eventName === "cellbehavior:clicked" ? "onClick" : "onDoubleClick";
  if (!mountedScriptHasHook(b.scriptId, hookName)) return false;

  const payload: CellBehaviorClickPayload = {
    bindingId: b.id,
    scriptId: b.scriptId,
    row,
    col,
    sheetIndex: b.sheetIndex,
    ctrlKey: event.ctrlKey === true,
    metaKey: event.metaKey === true,
  };
  emitAppEvent(eventName, payload);
  return b.claimClick;
}

// ============================================================================
// Backend sync
// ============================================================================

/** Re-pull all bindings and rebuild the index. Out-of-order responses drop. */
export async function refreshCellBehaviors(): Promise<void> {
  ensureInit();
  const seq = ++refreshSeq;
  try {
    const bindings = await invoke<CellBehaviorBinding[]>("get_all_cell_behaviors", {});
    if (seq !== refreshSeq) return;
    bindingsById.clear();
    for (const b of bindings) {
      bindingsById.set(b.id, b);
    }
    rebuildSpatialIndex();
    emitAppEvent(CELL_BEHAVIORS_CHANGED_EVENT);
  } catch (error) {
    console.error("[CellBehaviors] Failed to refresh bindings:", error);
  }
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  registerCellClickInterceptor((row, col, event) =>
    dispatchGesture("cellbehavior:clicked", row, col, event)
  );
  registerCellDoubleClickInterceptor((row, col, event) =>
    dispatchGesture("cellbehavior:dblclicked", row, col, event)
  );

  onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
    const d = detail as { sheetIndex?: number } | undefined;
    if (typeof d?.sheetIndex === "number") {
      activeSheetIndex = d.sheetIndex;
    }
  });

  const refreshEvents = [
    AppEvents.AFTER_OPEN,
    AppEvents.AFTER_NEW,
    AppEvents.ROWS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.COLUMNS_DELETED,
  ];
  for (const eventName of refreshEvents) {
    onAppEvent(eventName, () => {
      void refreshCellBehaviors();
    });
  }
  // Undo/redo of binding changes lands in the "objects" mutation domain.
  onAppEvent(AppEvents.MUTATION_REFRESH, (payload: { domains?: string[] } | undefined) => {
    if (!payload?.domains || payload.domains.includes("objects")) {
      void refreshCellBehaviors();
    }
  });
}

// ============================================================================
// CRUD (undoable via the backend store)
// ============================================================================

export interface AttachCellBehaviorOptions {
  /** The behavior's object script id (created by the caller). */
  scriptId: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Default true. */
  claimClick?: boolean;
  /** Reuse an existing binding id (edits); omitted = mint a new UUID. */
  id?: string;
}

/** Create or update a binding (undoable). Returns the stored binding. */
export async function attachCellBehavior(
  options: AttachCellBehaviorOptions
): Promise<CellBehaviorBinding> {
  ensureInit();
  const binding: CellBehaviorBinding = {
    id: options.id ?? crypto.randomUUID(),
    scriptId: options.scriptId,
    sheetIndex: options.sheetIndex,
    startRow: Math.min(options.startRow, options.endRow),
    startCol: Math.min(options.startCol, options.endCol),
    endRow: Math.max(options.startRow, options.endRow),
    endCol: Math.max(options.startCol, options.endCol),
    claimClick: options.claimClick ?? true,
    enabled: true,
    orphaned: false,
  };
  const stored = await invoke<CellBehaviorBinding>("set_cell_behavior", { binding });
  bindingsById.set(stored.id, stored);
  rebuildSpatialIndex();
  emitAppEvent(CELL_BEHAVIORS_CHANGED_EVENT);
  return stored;
}

/** Remove a binding (undoable). The script itself is left to the script UI. */
export async function removeCellBehavior(id: string): Promise<boolean> {
  const removed = await invoke<boolean>("remove_cell_behavior", { id });
  if (removed) {
    bindingsById.delete(id);
    rebuildSpatialIndex();
    emitAppEvent(CELL_BEHAVIORS_CHANGED_EVENT);
  }
  return removed;
}

/** Enable/disable a binding (undoable). */
export async function setCellBehaviorEnabled(id: string, enabled: boolean): Promise<boolean> {
  const ok = await invoke<boolean>("set_cell_behavior_enabled", { id, enabled });
  if (ok) {
    const b = bindingsById.get(id);
    if (b) b.enabled = enabled;
    emitAppEvent(CELL_BEHAVIORS_CHANGED_EVENT);
  }
  return ok;
}

// ============================================================================
// Test support
// ============================================================================

/** TEST-ONLY: reset module state (interceptors stay registered). */
export function __resetCellBehaviorsForTests(): void {
  bindingsById.clear();
  bySheet.clear();
  activeSheetIndex = 0;
  refreshSeq++;
}

/** TEST-ONLY: seed a binding without a backend round-trip. */
export function __seedCellBehaviorForTests(binding: CellBehaviorBinding): void {
  bindingsById.set(binding.id, binding);
  rebuildSpatialIndex();
}
