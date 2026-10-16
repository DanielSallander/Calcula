//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/harness.ts
// PURPOSE: Shared doubles for the object pane's tests: an in-memory task-pane
//          service (the Shell's store, reduced to what the pane reads), a
//          selection family, and floating regions.
// CONTEXT: The doubles go through the REAL seams (@api/ui's
//          registerTaskPaneService, @api/objectSelection's provider registry,
//          @api/gridOverlays' region list), so the host and the policy run
//          their real code against them.

import type { TaskPaneService } from "@api/ui";
import { registerTaskPaneService } from "@api/ui";
import type { TaskPaneViewDefinition } from "@api/uiTypes";
import type { GridRegion } from "@api/gridOverlays";
import { notifyObjectSelectionChanged, registerObjectSelectionProvider } from "@api/objectSelection";

export interface FakeTaskPanes {
  openPanes: string[];
  isOpen: boolean;
  manuallyClosed: string[];
  keys: string[];
  /** How many times openPane was called, per view. */
  opens: Record<string, number>;
  views: Map<string, TaskPaneViewDefinition>;
  /** The header's X: mark manually closed, then close (the Shell's order). */
  userCloses(viewId: string): void;
}

export function installFakeTaskPanes(): FakeTaskPanes {
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of Array.from(listeners)) l();
  };
  const st: FakeTaskPanes = {
    openPanes: [],
    isOpen: false,
    manuallyClosed: [],
    keys: [],
    opens: {},
    views: new Map(),
    userCloses(viewId: string) {
      service.markManuallyClosed(viewId);
      service.closePane(viewId);
    },
  };
  const service: TaskPaneService = {
    registerView: (d) => {
      st.views.set(d.id, d);
    },
    unregisterView: (id) => {
      st.views.delete(id);
    },
    getView: (id) => st.views.get(id),
    getAllViews: () => Array.from(st.views.values()),
    getViewsForContext: () => [],
    openPane: (id) => {
      st.opens[id] = (st.opens[id] ?? 0) + 1;
      if (!st.openPanes.includes(id)) st.openPanes.push(id);
      st.isOpen = true;
      st.manuallyClosed = st.manuallyClosed.filter((x) => x !== id);
      emit();
    },
    closePane: (id) => {
      st.openPanes = st.openPanes.filter((x) => x !== id);
      if (st.openPanes.length === 0) st.isOpen = false;
      emit();
    },
    open: () => {
      st.isOpen = true;
      emit();
    },
    close: () => {
      st.isOpen = false;
      emit();
    },
    isOpen: () => st.isOpen,
    getManuallyClosed: () => [...st.manuallyClosed],
    markManuallyClosed: (id) => {
      if (!st.manuallyClosed.includes(id)) st.manuallyClosed.push(id);
      emit();
    },
    clearManuallyClosed: (id) => {
      st.manuallyClosed = st.manuallyClosed.filter((x) => x !== id);
      emit();
    },
    addActiveContextKey: (k) => {
      if (!st.keys.includes(k)) st.keys.push(k);
    },
    removeActiveContextKey: (k) => {
      st.keys = st.keys.filter((x) => x !== k);
    },
    onRegistryChange: () => () => {},
    getOpenPaneIds: () => [...st.openPanes],
    onStateChange: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
  registerTaskPaneService(service);
  return st;
}

/** A floating region of `type` at (x, y). */
export function floatingRegion(id: string, type: string, x = 40, y = 40, width = 200, height = 120): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    data: { objectId: id },
    floating: { x, y, width, height },
  };
}

/** A single-select family for `type`: its own selection, announced like a real one. */
export function installSelectionFamily(type: string): { selected: Set<string>; cleanup: () => void } {
  const selected = new Set<string>();
  const cleanup = registerObjectSelectionProvider({
    types: [type],
    isSelected: (r) => selected.has(r.id),
    select: (r) => {
      selected.clear();
      selected.add(r.id);
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      if (selected.size === 0) return;
      selected.clear();
      notifyObjectSelectionChanged();
    },
    labelOf: (r) => `Object ${r.id}`,
  });
  return { selected, cleanup };
}
