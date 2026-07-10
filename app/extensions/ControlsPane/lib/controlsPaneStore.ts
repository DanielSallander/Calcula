//! FILENAME: app/extensions/ControlsPane/lib/controlsPaneStore.ts
// PURPOSE: Frontend cache for pane control state + the merged Controls-pane strip.
// CONTEXT: Mirrors filterPaneStore.ts for the pane-control entity family
//          (filterPaneStore stays untouched and owns the ribbon-filter side).
//          getPaneItems() merge-sorts both families into one strip (shared
//          `order` number space, D3). commitValue/previewValue implement the
//          drag-transience split (D5): previews are event-only — a transient
//          CONTROL_VALUE_CHANGED carrying the preview in its payload, cache
//          untouched; commits hit the backend, update the cache, and trigger
//          the targeted GET.CONTROLVALUE dependent recalc.
//          buildNamedControlList() feeds the @api/controlValues provider
//          (pane controls before filters = snapshot precedence order, D9).

import type {
  PaneControl,
  CreatePaneControlParams,
  UpdatePaneControlParams,
  ControlValue,
  PaneItem,
} from "./controlsPaneTypes";
import * as api from "./controlsPaneApi";
import { recalcControlDependents } from "./filterPaneApi";
import { ControlsPaneEvents } from "./controlsPaneEvents";
import { getAllFilters, filterControlValue } from "./filterPaneStore";
import {
  CONTROL_VALUE_CHANGED,
  type ControlValueChangedDetail,
  type NamedControl,
} from "@api/controlValues";
import { cellEvents } from "@api/cellEvents";
import { emitAppEvent, AppEvents } from "@api/events";

/** Fire-and-forget: re-evaluate GET.CONTROLVALUE formulas bound to `names`
 *  (ALL control names when omitted, e.g. after a rename) and apply the
 *  returned cells to the grid — same idiom as filterPaneStore's
 *  triggerControlValueRecalc (not exported there; filter files are frozen). */
function triggerControlValueRecalc(names?: string[]): void {
  recalcControlDependents(names)
    .then((cells) => {
      if (cells.length === 0) return;
      for (const cell of cells) {
        // Non-active sheets are recalculated backend-side and refresh on
        // sheet switch; only emit for active-sheet cells.
        if (cell.sheetIndex != null) continue;
        cellEvents.emit({
          row: cell.row,
          col: cell.col,
          newValue: cell.display,
          formula: cell.formula ?? null,
        });
      }
      emitAppEvent(AppEvents.GRID_REFRESH);
    })
    .catch((err) => {
      console.warn("[ControlsPane] GET.CONTROLVALUE recalc failed:", err);
    });
}

// ============================================================================
// Module-level cache
// ============================================================================

let cachedControls: PaneControl[] = [];

/** False until the first successful cache populate: the initial load must not
 *  diff-dispatch value events (reports would re-query on every workbook open). */
let cacheInitialized = false;

/** Diff two control snapshots and dispatch CONTROL_VALUE_CHANGED for every
 *  observable value change arriving OUTSIDE commitValue (undo/redo restores,
 *  renames, deletions) — keeps @Name-bound consumers (grid reports) in sync.
 *  App-wide event only: the pane-local counterpart is for live card updates,
 *  which CONTROLS_REFRESHED already covers on this path. */
function dispatchControlValueDiffs(previous: PaneControl[], next: PaneControl[]): void {
  const fire = (id: string, name: string, value: ControlValue | undefined) => {
    const detail: ControlValueChangedDetail = { id, name, value, transient: false };
    window.dispatchEvent(new CustomEvent(CONTROL_VALUE_CHANGED, { detail }));
  };
  const prevById = new Map(previous.map((c) => [c.id, c]));
  for (const control of next) {
    const old = prevById.get(control.id);
    prevById.delete(control.id);
    if (!old) {
      if (control.value !== undefined && control.value !== null) {
        fire(control.id, control.name, control.value);
      }
      continue;
    }
    if (old.name !== control.name) {
      fire(control.id, old.name, undefined);
      fire(control.id, control.name, control.value ?? undefined);
    } else if (JSON.stringify(old.value ?? null) !== JSON.stringify(control.value ?? null)) {
      fire(control.id, control.name, control.value ?? undefined);
    }
  }
  for (const gone of prevById.values()) {
    fire(gone.id, gone.name, undefined);
  }
}

// ============================================================================
// Accessors
// ============================================================================

export function getAllControls(): PaneControl[] {
  return cachedControls.sort((a, b) => a.order - b.order);
}

export function getControlById(id: string): PaneControl | undefined {
  return cachedControls.find((c) => c.id === id);
}

/** Look up a pane control by name, case-insensitively (GET.CONTROLVALUE
 *  resolves by uppercased name — mirror the Rust snapshot semantics). */
export function getControlByName(name: string): PaneControl | undefined {
  const upper = name.toUpperCase();
  return cachedControls.find((c) => c.name.toUpperCase() === upper);
}

// ============================================================================
// CRUD operations
// ============================================================================

export async function createControlAsync(
  params: CreatePaneControlParams,
): Promise<PaneControl | null> {
  try {
    const control = await api.createPaneControl(params);
    cachedControls = await api.getAllPaneControls();
    // GET.CONTROLVALUE: formulas already bound to the new control's name pick
    // up its initial value (value-less controls stay #N/A — recalc is a no-op).
    triggerControlValueRecalc([control.name]);
    // The cache was set directly (no refreshControlsCache diff): notify
    // @Name-bound consumers that this name now resolves.
    if (control.value !== undefined && control.value !== null) {
      dispatchValueChanged(control, control.value, false);
    }
    window.dispatchEvent(
      new CustomEvent(ControlsPaneEvents.CONTROL_CREATED, { detail: control }),
    );
    return control;
  } catch (err) {
    console.error("[ControlsPane] Failed to create control:", err);
    return null;
  }
}

export async function deleteControlAsync(controlId: string): Promise<boolean> {
  try {
    // Capture the name BEFORE the cache refresh drops the control
    // (needed for the targeted recalc below).
    const deletedName = getControlById(controlId)?.name;
    await api.deletePaneControl(controlId);
    await refreshControlsCache();
    // GET.CONTROLVALUE: formulas bound to the deleted control's name go #N/A.
    // Fall back to a full control recalc if the control wasn't in the cache.
    triggerControlValueRecalc(
      deletedName !== undefined ? [deletedName] : undefined,
    );
    window.dispatchEvent(
      new CustomEvent(ControlsPaneEvents.CONTROL_DELETED, {
        detail: { controlId },
      }),
    );
    return true;
  } catch (err) {
    console.error("[ControlsPane] Failed to delete control:", err);
    return false;
  }
}

export async function updateControlAsync(
  controlId: string,
  params: UpdatePaneControlParams,
): Promise<PaneControl | { error: string }> {
  try {
    const updated = await api.updatePaneControl(controlId, params);
    await refreshControlsCache();
    // Rename breaks GET.CONTROLVALUE bindings by name (Excel-like): formulas
    // bound to the old name go #N/A, ones bound to the new name pick up the
    // value — full control recalc, no name hint (plan: rename => full recalc).
    if (params.name !== undefined) {
      triggerControlValueRecalc();
    }
    window.dispatchEvent(
      new CustomEvent(ControlsPaneEvents.CONTROL_UPDATED, { detail: updated }),
    );
    return updated;
  } catch (err) {
    console.error("[ControlsPane] Failed to update control:", err);
    // Surface the backend rejection (e.g. the case-insensitive name-uniqueness
    // rule across pane controls AND ribbon filters) so callers can show it
    // inline instead of failing silently. Never rejects.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================================
// Value commit / preview (drag transience, D5)
// ============================================================================

/** Dispatch both value-changed events (pane-local + app-wide facade) with the
 *  shared ControlValueChangedDetail payload. */
function dispatchValueChanged(
  control: PaneControl,
  value: ControlValue,
  transient: boolean,
): void {
  const detail: ControlValueChangedDetail = {
    id: control.id,
    name: control.name,
    value,
    transient,
  };
  window.dispatchEvent(
    new CustomEvent(ControlsPaneEvents.CONTROL_VALUE_CHANGED_LOCAL, { detail }),
  );
  window.dispatchEvent(new CustomEvent(CONTROL_VALUE_CHANGED, { detail }));
}

/** Commit a control value: persist backend-side (one undo entry), update the
 *  local cache, fire a non-transient CONTROL_VALUE_CHANGED, and trigger the
 *  targeted GET.CONTROLVALUE dependent recalc. Slider drags call
 *  previewValue() per frame and commitValue() once on pointer-up. */
export async function commitValue(
  controlId: string,
  value: ControlValue,
): Promise<void> {
  try {
    await api.setPaneControlValue(controlId, value);
    const control = getControlById(controlId);
    if (control) {
      control.value = value;
      dispatchValueChanged(control, value, false);
      triggerControlValueRecalc([control.name]);
    } else {
      // Cache miss (stale cache): resync and recalc without a name hint.
      await refreshControlsCache();
      triggerControlValueRecalc();
    }
  } catch (err) {
    console.error("[ControlsPane] Failed to commit control value:", err);
  }
}

/** Preview a control value (e.g. mid-drag slider frame): event-only (D5).
 *  Dispatches a transient CONTROL_VALUE_CHANGED (+ the pane-local counterpart)
 *  with the preview in the event payload; the cached control keeps the last
 *  COMMITTED value so prop-driven consumers (cards re-rendering off the cache,
 *  the @api/controlValues provider snapshot) never observe uncommitted frames.
 *  NO cache mutation, NO backend write, NO undo entry, NO GET.CONTROLVALUE
 *  recalc — commitValue() is the single place control state changes. */
export function previewValue(controlId: string, value: ControlValue): void {
  const control = getControlById(controlId);
  if (!control) return;
  dispatchValueChanged(control, value, true);
}

// ============================================================================
// Merged Controls-pane strip
// ============================================================================

/** The merged strip: ribbon filters + pane controls, sorted by `order` asc
 *  (shared number space); ties break filters-before-controls, then id. */
export function getPaneItems(): PaneItem[] {
  const items: PaneItem[] = [
    ...getAllFilters().map(
      (filter): PaneItem => ({ kind: "filter", filter, order: filter.order }),
    ),
    ...getAllControls().map(
      (control): PaneItem => ({ kind: "control", control, order: control.order }),
    ),
  ];
  items.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.kind !== b.kind) return a.kind === "filter" ? -1 : 1;
    const aId = a.kind === "filter" ? a.filter.id : a.control.id;
    const bId = b.kind === "filter" ? b.filter.id : b.control.id;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
  return items;
}

// ============================================================================
// @api/controlValues provider mapping
// ============================================================================

/** Enumerate every named control the pane knows about, for the
 *  @api/controlValues provider. Pane controls first, then ribbon filters —
 *  the snapshot precedence order (pane control > ribbon filter). */
export function buildNamedControlList(): NamedControl[] {
  const controls: NamedControl[] = getAllControls().map((c) => ({
    id: c.id,
    name: c.name,
    source: "paneControl" as const,
    controlType: c.controlType,
    value: c.value ?? undefined,
  }));
  const filters: NamedControl[] = getAllFilters().map((f) => ({
    id: f.id,
    name: f.name,
    source: "ribbonFilter" as const,
    controlType: "filter",
    value: filterControlValue(f.selectedItems),
  }));
  return [...controls, ...filters];
}

// ============================================================================
// Cache management
// ============================================================================

export async function refreshControlsCache(): Promise<void> {
  try {
    const previous = cacheInitialized ? cachedControls : null;
    cachedControls = await api.getAllPaneControls();
    cacheInitialized = true;
    // Backend-side changes (undo/redo restores, renames, deletes) reach the
    // cache only through here — diff so @Name-bound consumers hear about them.
    if (previous) {
      dispatchControlValueDiffs(previous, cachedControls);
    }
    window.dispatchEvent(
      new CustomEvent(ControlsPaneEvents.CONTROLS_REFRESHED),
    );
  } catch (err) {
    console.error("[ControlsPane] Failed to refresh controls cache:", err);
  }
}

/** Clear all cached state (used on extension deactivation). */
export function clearControlsCache(): void {
  cachedControls = [];
  cacheInitialized = false;
}
