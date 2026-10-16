//! FILENAME: app/src/shell/TaskPane/__tests__/taskPaneUpdate.test.tsx
// PURPOSE: A view's `onUpdate` prop runs what THAT view's definition says
//          (`TaskPaneViewDefinition.onUpdate`), and nothing else. The Shell used
//          to broadcast "pivot:refresh" for EVERY view, so any pane that called
//          onUpdate re-fetched and repainted every pivot in the workbook (WP-C
//          D-PANE infrastructure fix). The pivot editor's definition keeps the
//          announcement for itself (Pivot/manifest.ts `PivotPaneDefinition`).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TaskPaneContainer } from "../TaskPaneContainer";
import { useTaskPaneStore } from "../useTaskPaneStore";
import { registerTaskPaneService, type TaskPaneService } from "../../../api/ui";
import type { TaskPaneViewDefinition, TaskPaneViewProps } from "../../../api/uiTypes";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const views = new Map<string, TaskPaneViewDefinition>();

/** A view body with a button that calls its onUpdate prop, as the pivot editor does. */
function UpdatingBody({ onUpdate }: TaskPaneViewProps): React.ReactElement {
  return (
    <button data-testid="update" onClick={() => onUpdate?.()}>
      update
    </button>
  );
}

const service: TaskPaneService = {
  registerView: (def) => void views.set(def.id, def),
  unregisterView: (id) => void views.delete(id),
  getView: (id) => views.get(id),
  getAllViews: () => Array.from(views.values()),
  getViewsForContext: () => [],
  openPane: () => {},
  closePane: () => {},
  open: () => {},
  close: () => {},
  isOpen: () => false,
  getManuallyClosed: () => [],
  markManuallyClosed: () => {},
  clearManuallyClosed: () => {},
  addActiveContextKey: () => {},
  removeActiveContextKey: () => {},
  onRegistryChange: () => () => {},
};

let pivotRefreshes = 0;
const onPivotRefresh = (): void => {
  pivotRefreshes += 1;
};

function renderPane(): void {
  act(() => root.render(<TaskPaneContainer />));
}

function clickUpdate(): void {
  const btn = container.querySelector<HTMLButtonElement>("[data-testid='update']");
  if (!btn) throw new Error("the active view did not render");
  act(() => btn.click());
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  views.clear();
  registerTaskPaneService(service);
  useTaskPaneStore.getState().reset();
  pivotRefreshes = 0;
  window.addEventListener("pivot:refresh", onPivotRefresh);
});

afterEach(() => {
  window.removeEventListener("pivot:refresh", onPivotRefresh);
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  useTaskPaneStore.getState().reset();
});

describe("task pane onUpdate", () => {
  it("a non-pivot view's onUpdate dispatches NO pivot:refresh", () => {
    views.set("object-pane", {
      id: "object-pane",
      title: "Object pane",
      component: UpdatingBody,
      contextKeys: ["object"],
    });
    act(() => useTaskPaneStore.getState().openPane("object-pane"));
    renderPane();

    clickUpdate();
    expect(pivotRefreshes).toBe(0);
  });

  it("a view's onUpdate runs ITS definition's onUpdate, once per call", () => {
    const own = vi.fn();
    views.set("v", { id: "v", title: "V", component: UpdatingBody, contextKeys: ["always"], onUpdate: own });
    act(() => useTaskPaneStore.getState().openPane("v"));
    renderPane();

    clickUpdate();
    clickUpdate();
    expect(own).toHaveBeenCalledTimes(2);
    expect(pivotRefreshes).toBe(0);
  });

  it("the pivot editor's view announces pivot:refresh through its own definition", async () => {
    const { PivotPaneDefinition, PIVOT_PANE_ID } = await import("../../../../extensions/Pivot/manifest");
    views.set(PIVOT_PANE_ID, { ...PivotPaneDefinition, component: UpdatingBody });
    act(() => useTaskPaneStore.getState().openPane(PIVOT_PANE_ID));
    renderPane();

    clickUpdate();
    expect(pivotRefreshes).toBe(1);
  });

  it("onUpdate follows the ACTIVE view when the user switches panes", () => {
    const a = vi.fn();
    const b = vi.fn();
    views.set("a", { id: "a", title: "A", component: UpdatingBody, contextKeys: ["always"], onUpdate: a });
    views.set("b", { id: "b", title: "B", component: UpdatingBody, contextKeys: ["always"], onUpdate: b });
    act(() => {
      useTaskPaneStore.getState().openPane("a");
      useTaskPaneStore.getState().openPane("b");
    });
    renderPane();
    clickUpdate();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();

    act(() => useTaskPaneStore.getState().setActiveView("a"));
    clickUpdate();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
