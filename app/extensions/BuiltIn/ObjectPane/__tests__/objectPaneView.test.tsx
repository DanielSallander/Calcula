//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/objectPaneView.test.tsx
// PURPOSE: The object pane's view, rendered against the REAL host and seams:
//            - the tab strip is the family's build tabs + Format, each tab
//              button carrying `data-tab-id`;
//            - the BUILD slot stays MOUNTED (display:none) while Format shows,
//              so a build tab's state survives a Format visit, and is keyed by
//              the object (a retarget remounts it);
//            - the header names the object and says "(1 of N selected)";
//            - a subscribed page shows the read-only banner;
//            - opening and switching tabs never moves focus; Escape inside the
//              pane gives the keyboard back to the grid.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ restoreFocus: vi.fn() }));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "canvas", sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  restoreFocusToGrid: () => h.restoreFocus(),
}));

import { setGridRegions } from "@api/gridOverlays";
import {
  OBJECT_PANE_FORMAT_TAB,
  getObjectPaneState,
  openObjectPane,
  registerObjectPaneHost,
  registerObjectPaneProvider,
  resetObjectPane,
} from "@api/objectPane";
import { addToObjectSelection, resetObjectSelectionProviders, selectObject } from "@api/objectSelection";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { SIZE_POSITION_SUBSCRIBED } from "@api/objectPosition";
import { createObjectPaneHost } from "../lib/objectPaneHost";
import { installObjectPanePolicy } from "../lib/objectPanePolicy";
import { resetPaneState } from "../lib/paneState";
import { resetTabMemory } from "../lib/tabMemory";
import { ObjectPaneView } from "../components/ObjectPaneView";
import { floatingRegion, installFakeTaskPanes, installSelectionFamily } from "./harness";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const TYPE = "fake-object";
const OTHER = "other-object";
const A = floatingRegion("obj-a", TYPE, 40, 40);
const B = floatingRegion("obj-b", TYPE, 300, 40);
const C = floatingRegion("obj-c", OTHER, 40, 300);

/** Counts its mounts, and keeps typed state, so a remount is visible. */
let mounts = 0;
function BuildBody({ label }: { label: string }): React.ReactElement {
  const [count, setCount] = useState(0);
  React.useEffect(() => {
    mounts++;
  }, []);
  return (
    <button type="button" data-testid="build-body" onClick={() => setCount((n) => n + 1)}>
      {label}:{count}
    </button>
  );
}

let container: HTMLDivElement;
let root: Root;
let surface: LayoutSurface | null = null;
const cleanups: Array<() => void> = [];

function render(): void {
  act(() => root.render(<ObjectPaneView />));
}

function tabButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="object-pane-tabs"] [role="tab"]'));
}

function clickTab(id: string): void {
  const btn = container.querySelector<HTMLButtonElement>(`[data-testid="object-pane-tabs"] [data-tab-id="${id}"]`);
  if (!btn) throw new Error(`no tab ${id}`);
  act(() => btn.click());
}

beforeEach(() => {
  mounts = 0;
  surface = null;
  h.restoreFocus.mockClear();
  resetObjectPane();
  resetObjectSelectionProviders();
  resetPaneState();
  resetTabMemory(true);
  installFakeTaskPanes();
  const fam = installSelectionFamily(TYPE);
  const other = installSelectionFamily(OTHER);
  cleanups.push(fam.cleanup, other.cleanup);
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
  setGridRegions([A, B, C]);
  cleanups.push(
    registerObjectPaneProvider({
      types: [TYPE],
      tabs: () => [
        { id: "fields", label: "Fields", render: () => <BuildBody label="editor" /> },
        { id: "design", label: "Design", render: () => <BuildBody label="editor" /> },
      ],
      headerOf: (r) => `Thing - ${r.id}`,
    }),
  );
  cleanups.push(registerObjectPaneProvider({ types: [OTHER], tabs: () => [] }));
  cleanups.push(registerObjectPaneHost(createObjectPaneHost()));
  cleanups.push(installObjectPanePolicy());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("the object pane view", () => {
  it("shows the family's build tabs + Format, each tab carrying data-tab-id", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    render();
    expect(tabButtons().map((b) => b.textContent)).toEqual(["Fields", "Design", "Format"]);
    expect(tabButtons().map((b) => b.getAttribute("data-tab-id"))).toEqual(["fields", "design", OBJECT_PANE_FORMAT_TAB]);
    const root = container.querySelector('[data-testid="object-pane"]')!;
    expect(root.getAttribute("data-region-id")).toBe(A.id);
    expect(root.getAttribute("data-active-tab")).toBe("fields");
  });

  it("an object with no build tabs shows Format only", () => {
    selectObject(C);
    openObjectPane({ reason: "command" });
    render();
    expect(tabButtons().map((b) => b.textContent)).toEqual(["Format"]);
    expect(container.querySelector('[data-testid="object-pane-format"]')).not.toBeNull();
  });

  it("the build slot stays MOUNTED across Format, with its state; one instance across same-type tabs", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    render();
    const body = () => container.querySelector<HTMLButtonElement>('[data-testid="build-body"]')!;
    act(() => body().click());
    act(() => body().click());
    expect(body().textContent).toBe("editor:2");
    expect(mounts).toBe(1);

    clickTab(OBJECT_PANE_FORMAT_TAB);
    expect(getObjectPaneState().tabId).toBe(OBJECT_PANE_FORMAT_TAB);
    const slot = container.querySelector<HTMLElement>('[data-testid="object-pane-build-slot"]')!;
    expect(slot.style.display).toBe("none");
    expect(body().textContent).toBe("editor:2");

    clickTab("design");
    expect(slot.isConnected).toBe(true);
    expect(container.querySelector<HTMLElement>('[data-testid="object-pane-build-slot"]')!.style.display).toBe("block");
    expect(body().textContent).toBe("editor:2"); // same component type: the same instance
    expect(mounts).toBe(1);
  });

  it("a retarget remounts the build slot for the new object (keyed by region id)", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    render();
    expect(mounts).toBe(1);
    act(() => {
      selectObject(B);
    });
    expect(getObjectPaneState().regionId).toBe(B.id);
    expect(container.querySelector('[data-testid="object-pane"]')!.getAttribute("data-region-id")).toBe(B.id);
    expect(mounts).toBe(2);
  });

  it("the header names the object and says (1 of N selected) with several selected", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    render();
    const header = () => container.querySelector('[data-testid="object-pane-header"]')!.textContent;
    expect(header()).toBe(`Thing - ${A.id}`);
    act(() => {
      addToObjectSelection(C);
    });
    expect(header()).toContain("(1 of 2 selected)");
  });

  it("a subscribed page shows the read-only banner", () => {
    surface = { editable: false } as LayoutSurface;
    selectObject(A);
    openObjectPane({ reason: "command" });
    render();
    expect(container.querySelector('[data-testid="object-pane-readonly"]')!.textContent).toBe(SIZE_POSITION_SUBSCRIBED);
  });

  it("never takes focus: opening and switching tabs leave document.activeElement alone", () => {
    const grid = document.createElement("div");
    grid.setAttribute("data-focus-container", "spreadsheet");
    const surfaceEl = document.createElement("div");
    surfaceEl.tabIndex = 0;
    grid.appendChild(surfaceEl);
    document.body.appendChild(grid);
    surfaceEl.focus();
    try {
      selectObject(A);
      act(() => {
        openObjectPane({ reason: "command" });
      });
      render();
      expect(document.activeElement).toBe(surfaceEl);
      act(() => {
        openObjectPane({ tab: OBJECT_PANE_FORMAT_TAB, reason: "command" });
      });
      expect(document.activeElement).toBe(surfaceEl);
    } finally {
      grid.remove();
    }
  });

  it("Escape inside the pane gives the keyboard back to the grid", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    render();
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="build-body"]')!;
    btn.focus();
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(h.restoreFocus).toHaveBeenCalledTimes(1);
  });

  it("with nothing to show it says so", () => {
    render();
    expect(container.querySelector('[data-testid="object-pane-empty"]')).not.toBeNull();
  });
});
