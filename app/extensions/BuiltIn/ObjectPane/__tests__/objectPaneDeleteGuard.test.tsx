//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/objectPaneDeleteGuard.test.tsx
// PURPOSE: Focus inside the object pane must never let an object's Delete fire
//          (the BUG-0125 class: "select a chart, click a tab in the Format
//          pane, press Delete" once DESTROYED the chart). With a pane <button>
//          focused, every Delete door stands down:
//            - the canvas's whole-selection Delete (CanvasSheet canvasDelete),
//            - the generic selected-object Delete (ObjectPosition),
//            - the chart's own key door (`chartOwnsKeystroke`).
//          Each is first shown to APPLY with the grid focused (the positive
//          control), so the "stands down" half is not a door that never fires.
// CONTEXT: A test may import other extensions' modules (the boundary rule
//          exempts tests); the pane itself imports none of them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", sheetContext: { activeSheetIndex: 0 } }),
}));

import { setGridRegions } from "@api/gridOverlays";
import {
  OBJECT_PANE_FORMAT_TAB,
  openObjectPane,
  registerObjectPaneHost,
  registerObjectPaneProvider,
  resetObjectPane,
} from "@api/objectPane";
import { addToObjectSelection, resetObjectSelectionProviders, selectObject } from "@api/objectSelection";
import { createObjectPaneHost } from "../lib/objectPaneHost";
import { resetPaneState } from "../lib/paneState";
import { ObjectPaneView } from "../components/ObjectPaneView";
import { canvasDeleteApplies } from "../../../CanvasSheet/lib/canvasDelete";
import { objectDeleteApplies } from "../../ObjectPosition/lib/selectedObjectKeys";
import { chartOwnsKeystroke } from "../../../Charts/handlers/selectionHandler";
import { floatingRegion, installFakeTaskPanes, installSelectionFamily } from "./harness";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const A = floatingRegion("obj-a", "fam-one", 40, 40);
const B = floatingRegion("obj-b", "fam-two", 300, 40);

let container: HTMLDivElement;
let root: Root;
let gridSurface: HTMLElement;
const cleanups: Array<() => void> = [];

function deleteKey(target: EventTarget): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: target });
  return e;
}

beforeEach(() => {
  resetObjectPane();
  resetObjectSelectionProviders();
  resetPaneState();
  installFakeTaskPanes();
  const one = installSelectionFamily("fam-one");
  const two = installSelectionFamily("fam-two");
  cleanups.push(one.cleanup, two.cleanup);
  setGridRegions([A, B]);
  cleanups.push(
    registerObjectPaneProvider({
      types: ["fam-one", "fam-two"],
      tabs: () => [{ id: "settings", label: "Settings", render: () => <button type="button">Inside</button> }],
    }),
  );
  cleanups.push(registerObjectPaneHost(createObjectPaneHost()));

  const grid = document.createElement("div");
  grid.setAttribute("data-focus-container", "spreadsheet");
  gridSurface = document.createElement("div");
  gridSurface.tabIndex = 0;
  grid.appendChild(gridSurface);
  document.body.appendChild(grid);
  cleanups.push(() => grid.remove());

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  // Two families selected: the canvas whole-selection Delete would act.
  selectObject(A);
  addToObjectSelection(B);
  openObjectPane({ region: A, tab: OBJECT_PANE_FORMAT_TAB, reason: "command" });
  act(() => root.render(<ObjectPaneView />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("Delete with focus in the object pane", () => {
  it("POSITIVE CONTROL: with the grid focused, every Delete door applies", () => {
    gridSurface.focus();
    expect(canvasDeleteApplies()).toBe(true);
    expect(objectDeleteApplies()).toBe(true);
    expect(chartOwnsKeystroke(deleteKey(gridSurface))).toBe(true);
  });

  it("with a pane <button> focused (a card header), every Delete door stands down", () => {
    const header = container.querySelector<HTMLButtonElement>("[data-format-card-header]");
    expect(header, "the Format tab rendered no card header to focus").not.toBeNull();
    header!.focus();
    expect(document.activeElement).toBe(header);
    expect(canvasDeleteApplies()).toBe(false);
    expect(objectDeleteApplies()).toBe(false);
    expect(chartOwnsKeystroke(deleteKey(header!))).toBe(false);
  });

  it("with a pane tab focused, every Delete door stands down", () => {
    const tab = container.querySelector<HTMLButtonElement>('[data-testid="object-pane-tabs"] [role="tab"]')!;
    tab.focus();
    expect(canvasDeleteApplies()).toBe(false);
    expect(objectDeleteApplies()).toBe(false);
    expect(chartOwnsKeystroke(deleteKey(tab))).toBe(false);
  });
});
