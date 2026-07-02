//! FILENAME: app/extensions/Pivot/lib/pivotPanelStore.ts
// PURPOSE: Shared reactive state for the contextual pivot panels
//          ("Pivot Table" analyze + "Pivot Table Design").
// CONTEXT: The old monolithic ribbon tab components each owned this state
//          locally. Panel sections are independently mounted components, so
//          they share this module-level store — a layout change made in one
//          section must be visible to the others before their next
//          PIVOT_LAYOUT_CHANGED emit, or stale per-section copies would revert
//          each other's changes. The store attaches its event listeners when
//          the first section mounts and resets when the last unmounts,
//          mirroring the old tab components' mount/unmount lifecycle.

import { useSyncExternalStore } from "react";
import { onAppEvent, emitAppEvent } from "@api";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import { getActivePivotId } from "../handlers/selectionHandler";
import { getPivotTableInfo } from "./pivot-api";
import type { LayoutConfig, PivotId } from "../components/types";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** Layout state shared with the design sections. */
export interface PivotLayoutState {
  pivotId: PivotId | null;
  layout: LayoutConfig;
}

/** PIVOT_LAYOUT_STATE broadcast detail (layout may be omitted by emitters). */
interface PivotLayoutBroadcast {
  pivotId: PivotId | null;
  layout?: LayoutConfig;
}

export interface PivotPanelState {
  /** Active pivot for the analyze sections (null → "Select a PivotTable..."). */
  pivotId: PivotId | null;
  /** Layout state for the design sections — non-null once a broadcast (or the
   *  mount-time active-pivot pickup) has arrived, mirroring the old design
   *  tab's `layoutState !== null` gate. */
  layoutState: PivotLayoutState | null;
  /** Source range display for the analyze "PivotTable" section. */
  sourceRange: string;
}

const INITIAL_STATE: PivotPanelState = {
  pivotId: null,
  layoutState: null,
  sourceRange: "",
};

let state: PivotPanelState = INITIAL_STATE;
const listeners = new Set<() => void>();
let detachFns: (() => void)[] = [];
let refCount = 0;

function setState(patch: Partial<PivotPanelState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

// ---------------------------------------------------------------------------
// Source range fetching (analyze "PivotTable" section)
// ---------------------------------------------------------------------------

function fetchSourceRange(pivotId: PivotId): void {
  getPivotTableInfo(pivotId)
    .then((info) => {
      // Ignore stale responses if the active pivot changed mid-flight
      if (state.pivotId === pivotId) {
        setState({ sourceRange: info.sourceRange });
      }
    })
    .catch(() => {
      /* ignore */
    });
}

/**
 * Re-fetch the source range shown in the analyze "PivotTable" section.
 * Called after "Change Data Source" completes.
 */
export function refreshSourceRange(): void {
  if (state.pivotId) {
    fetchSourceRange(state.pivotId);
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleLayoutStateBroadcast(detail: PivotLayoutBroadcast): void {
  console.log(`[CALP-DIAG] pivotPanelStore received PIVOT_LAYOUT_STATE: pivotId=${detail.pivotId}`);
  const prev = state.layoutState;
  const layout = detail.layout ?? {};
  const pivotChanged = state.pivotId !== detail.pivotId;
  setState({
    pivotId: detail.pivotId,
    layoutState: {
      pivotId: detail.pivotId,
      layout: {
        ...layout,
        // Preserve styleId if the broadcast doesn't include it
        // (backend doesn't know about this frontend-only property)
        styleId: layout.styleId ?? prev?.layout.styleId,
      },
    },
  });
  if (pivotChanged && detail.pivotId) {
    fetchSourceRange(detail.pivotId);
  }
}

function handleDeselected(): void {
  setState({ pivotId: null, layoutState: null, sourceRange: "" });
}

// ---------------------------------------------------------------------------
// Attach / detach (first-subscriber / last-subscriber lifecycle)
// ---------------------------------------------------------------------------

function attach(): void {
  detachFns.push(
    onAppEvent<PivotLayoutBroadcast>(PivotEvents.PIVOT_LAYOUT_STATE, handleLayoutStateBroadcast),
  );
  window.addEventListener("pivot:deselected", handleDeselected);
  detachFns.push(() => window.removeEventListener("pivot:deselected", handleDeselected));

  // Try to get the active pivot directly (covers the case where the event
  // was emitted before any section mounted), else request current state
  // from the task pane (if open).
  const active = getActivePivotId();
  if (active !== null) {
    console.log(`[CALP-DIAG] pivotPanelStore attached, found activePivotId=${active}`);
    setState({
      pivotId: active,
      layoutState: state.layoutState ?? { pivotId: active, layout: {} },
    });
    fetchSourceRange(active);
  } else {
    console.log(`[CALP-DIAG] pivotPanelStore attached, requesting layout state`);
    emitAppEvent(PivotEvents.PIVOT_REQUEST_LAYOUT);
  }
}

function detach(): void {
  for (const fn of detachFns) {
    fn();
  }
  detachFns = [];
  // Mirror the old tab components: unmount discarded their local state, so a
  // later remount re-initializes from getActivePivotId() / broadcasts.
  state = INITIAL_STATE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  refCount += 1;
  if (refCount === 1) {
    attach();
  }
  return () => {
    listeners.delete(listener);
    refCount -= 1;
    if (refCount === 0) {
      detach();
    }
  };
}

function getSnapshot(): PivotPanelState {
  return state;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** React hook: subscribe a panel section to the shared pivot panel state. */
export function usePivotPanelState(): PivotPanelState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Merge layout updates into the shared state and broadcast PIVOT_LAYOUT_CHANGED
 * (same contract as the old design tab's updateLayout). No-op when no layout
 * state is active.
 */
export function updateSharedLayout(updates: Partial<LayoutConfig>): void {
  const current = state.layoutState;
  if (!current) {
    return;
  }
  const newLayout = { ...current.layout, ...updates };
  setState({ layoutState: { ...current, layout: newLayout } });
  emitAppEvent(PivotEvents.PIVOT_LAYOUT_CHANGED, {
    pivotId: current.pivotId,
    layout: newLayout,
  });
}
