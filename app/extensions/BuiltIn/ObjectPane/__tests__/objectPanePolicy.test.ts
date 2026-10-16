//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/objectPanePolicy.test.ts
// PURPOSE: The object pane's open policy (D-PANE), against the REAL host, the
//          REAL @api/objectPane / @api/objectSelection seams and an in-memory
//          task-pane service:
//            - a canvas press + release on an object opens the pane;
//            - a press that MOVED opens nothing -- a completed move, and also
//              pointer travel past the drag threshold with NO moveComplete (a
//              drag-select across a pivot's cells);
//            - a run-mode button (opensOnPress false), a worksheet press, a grip
//              press and a Ctrl press open nothing;
//            - keyboard selection (selectObject) never OPENS the pane, but an
//              open pane FOLLOWS it (keeping its tab when offered);
//            - no primary object closes the pane and drops the "object" key;
//            - the Shell's X (manuallyClosed) blocks a press and a follow, never
//              a door; View > Show (`taskpane:requestReopen`) is a door;
//            - File > New closes it and drops Core's painted container layouts;
//            - an object that vanishes closes the pane;
//            - a double-click opens the pane once and keeps the object.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  surface: "canvas" as "canvas" | "worksheet",
  resetLayouts: vi.fn(),
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: h.surface, sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("@api/visualContainerPaint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/visualContainerPaint")>()),
  resetPaintedContainerLayouts: () => h.resetLayouts(),
}));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  OBJECT_PANE_FORMAT_TAB,
  OBJECT_PANE_ID,
  closeObjectPane,
  getObjectPaneState,
  openObjectPane,
  registerObjectPaneHost,
  registerObjectPaneProvider,
  resetObjectPane,
  type ObjectPaneProvider,
} from "@api/objectPane";
import {
  clearObjectSelection,
  noteObjectPress,
  notifyObjectSelectionChanged,
  resetObjectSelectionProviders,
  selectObject,
} from "@api/objectSelection";
import { AppEvents, emitAppEvent } from "@api/events";
import { createObjectPaneHost, selectObjectPaneTab } from "../lib/objectPaneHost";
import { installObjectPanePolicy } from "../lib/objectPanePolicy";
import { resetPaneState } from "../lib/paneState";
import { resetTabMemory } from "../lib/tabMemory";
import { floatingRegion, installFakeTaskPanes, installSelectionFamily, type FakeTaskPanes } from "./harness";

const TYPE = "fake-object";
const A = floatingRegion("obj-a", TYPE, 40, 40);
const B = floatingRegion("obj-b", TYPE, 300, 40);

let panes: FakeTaskPanes;
let family: { selected: Set<string>; cleanup: () => void };
let provider: ObjectPaneProvider;
let opensOnPress = true;
const cleanups: Array<() => void> = [];

/** What Core and a family do for a primary press on `region`. */
function press(
  region: GridRegion,
  opts: { part?: string; ctrlKey?: boolean; shiftKey?: boolean } = {},
): void {
  noteObjectPress(region, { ctrlKey: opts.ctrlKey, shiftKey: opts.shiftKey });
  // The family's own selected handler selects its object.
  family.selected.clear();
  family.selected.add(region.id);
  notifyObjectSelectionChanged();
  window.dispatchEvent(
    new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: region.id,
        regionType: region.type,
        data: region.data,
        zone: "content",
        part: opts.part ?? "body",
        canvasX: 10,
        canvasY: 10,
        ctrlKey: opts.ctrlKey === true,
        shiftKey: opts.shiftKey === true,
      },
    }),
  );
}

function move(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
}

function release(): void {
  window.dispatchEvent(new MouseEvent("mouseup"));
  vi.runAllTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.surface = "canvas";
  h.resetLayouts.mockClear();
  opensOnPress = true;
  resetObjectPane();
  resetObjectSelectionProviders();
  resetPaneState();
  resetTabMemory(true);
  panes = installFakeTaskPanes();
  family = installSelectionFamily(TYPE);
  setGridRegions([A, B]);
  provider = {
    types: [TYPE],
    tabs: () => [
      { id: "settings", label: "Settings", render: () => null },
      { id: "data", label: "Data", render: () => null },
    ],
    opensOnPress: () => opensOnPress,
  };
  cleanups.push(registerObjectPaneProvider(provider));
  cleanups.push(registerObjectPaneHost(createObjectPaneHost()));
  cleanups.push(installObjectPanePolicy());
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  family.cleanup();
  setGridRegions([]);
  vi.useRealTimers();
});

describe("auto-open at the release of a canvas click", () => {
  it("a canvas press + release on an object opens the pane on it, without focusing anything", () => {
    const focused = document.activeElement;
    press(A);
    expect(getObjectPaneState().open).toBe(false); // not at the press
    release();
    const s = getObjectPaneState();
    expect(s.open).toBe(true);
    expect(s.regionId).toBe(A.id);
    expect(s.tabId).toBe("settings");
    expect(panes.openPanes).toEqual([OBJECT_PANE_ID]);
    expect(panes.keys).toContain("object");
    expect(document.activeElement).toBe(focused);
  });

  it("a press whose move completed opens nothing", () => {
    press(A);
    window.dispatchEvent(new CustomEvent("floatingObject:moveComplete", { detail: { regionId: A.id } }));
    release();
    expect(getObjectPaneState().open).toBe(false);
    expect(panes.openPanes).toEqual([]);
  });

  it("a press that travels 10 px with NO moveComplete (a drag-select across cells) opens nothing", () => {
    press(A);
    move(100, 100);
    move(110, 100);
    release();
    expect(getObjectPaneState().open).toBe(false);
  });

  it("travel within the threshold is still a click", () => {
    press(A);
    move(100, 100);
    move(103, 102);
    release();
    expect(getObjectPaneState().open).toBe(true);
  });

  it("a run-mode button (opensOnPress false) opens nothing", () => {
    opensOnPress = false;
    press(A);
    release();
    expect(getObjectPaneState().open).toBe(false);
  });

  it("a worksheet press opens nothing (worksheets open only through doors)", () => {
    h.surface = "worksheet";
    press(A);
    release();
    expect(getObjectPaneState().open).toBe(false);
  });

  it("a grip press opens nothing", () => {
    press(A, { part: "grip" });
    release();
    expect(getObjectPaneState().open).toBe(false);
  });

  it("a Ctrl press (selection-set edit) opens nothing", () => {
    press(A, { ctrlKey: true });
    release();
    expect(getObjectPaneState().open).toBe(false);
  });

  it("a release whose object is no longer the primary opens nothing", () => {
    press(A);
    // Something else selected B before the deferred decision ran.
    selectObject(B);
    release();
    expect(getObjectPaneState().open).toBe(false);
  });

  it("press-release-press-release (a double-click) opens the pane once and keeps the same object", () => {
    press(A);
    window.dispatchEvent(new MouseEvent("mouseup")); // first release: decision deferred
    press(A); // the second press settles it
    release();
    const s = getObjectPaneState();
    expect(s.open).toBe(true);
    expect(s.regionId).toBe(A.id);
    expect(family.selected.has(A.id)).toBe(true);
    expect(panes.opens[OBJECT_PANE_ID]).toBe(2);
  });
});

describe("keyboard selection and following", () => {
  it("selectObject (Tab) never OPENS the pane -- only the context key follows", () => {
    selectObject(A);
    vi.runAllTimers();
    expect(getObjectPaneState().open).toBe(false);
    expect(panes.openPanes).toEqual([]);
    expect(panes.keys).toContain("object");
  });

  it("an open pane FOLLOWS a keyboard select, keeping the tab the new object offers", () => {
    selectObject(A);
    expect(openObjectPane({ tab: "data", reason: "command" })).toBe(true);
    const opensBefore = panes.opens[OBJECT_PANE_ID];
    selectObject(B);
    const s = getObjectPaneState();
    expect(s.open).toBe(true);
    expect(s.regionId).toBe(B.id);
    expect(s.tabId).toBe("data");
    // A follow retargets in place: it does not re-open (pull) the task pane.
    expect(panes.opens[OBJECT_PANE_ID]).toBe(opensBefore);
  });

  it("no primary object closes the pane and drops the 'object' key", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    expect(getObjectPaneState().open).toBe(true);
    clearObjectSelection();
    expect(getObjectPaneState().open).toBe(false);
    expect(panes.openPanes).toEqual([]);
    expect(panes.keys).not.toContain("object");
  });

  it("an object that vanishes closes the pane", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    family.selected.clear(); // its family dropped it silently
    setGridRegions([B]);
    vi.runAllTimers();
    expect(getObjectPaneState().open).toBe(false);
  });
});

describe("which tab an open lands on", () => {
  it("a tab the reader picked in the strip is remembered for the family; a door's tab is not", () => {
    selectObject(A);
    openObjectPane({ tab: OBJECT_PANE_FORMAT_TAB, reason: "command" });
    closeObjectPane();
    press(A);
    release();
    expect(getObjectPaneState().tabId).toBe("settings"); // the door's Format was not a preference

    selectObjectPaneTab("data");
    closeObjectPane();
    press(B);
    release();
    expect(getObjectPaneState().regionId).toBe(B.id);
    expect(getObjectPaneState().tabId).toBe("data");
  });

  it("the family's defaultTab wins over the memory; a requested tab wins over both", () => {
    provider.defaultTab = () => "data";
    selectObject(A);
    openObjectPane({ reason: "command" });
    expect(getObjectPaneState().tabId).toBe("data");
    openObjectPane({ tab: "settings", reason: "command" });
    expect(getObjectPaneState().tabId).toBe("settings");
  });

  it("a tab the object does not offer is ignored", () => {
    selectObject(A);
    openObjectPane({ tab: "nope", reason: "command" });
    expect(getObjectPaneState().tabId).toBe("settings");
  });
});

describe("the pane the user closed", () => {
  it("the Shell's X closes it; a press and a follow do not reopen it; a door does", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    panes.userCloses(OBJECT_PANE_ID);
    expect(getObjectPaneState().open).toBe(false);

    press(B);
    release();
    expect(getObjectPaneState().open).toBe(false);
    expect(openObjectPane({ region: B, reason: "follow" })).toBe(false);

    expect(openObjectPane({ tab: OBJECT_PANE_FORMAT_TAB, reason: "command" })).toBe(true);
    const s = getObjectPaneState();
    expect(s.open).toBe(true);
    expect(s.regionId).toBe(B.id);
    expect(s.tabId).toBe(OBJECT_PANE_FORMAT_TAB);
  });

  it("View > Show (taskpane:requestReopen) opens it for the primary object", () => {
    selectObject(A);
    panes.manuallyClosed.push(OBJECT_PANE_ID);
    window.dispatchEvent(new CustomEvent("taskpane:requestReopen", { detail: { viewId: OBJECT_PANE_ID } }));
    expect(getObjectPaneState().open).toBe(true);
    expect(getObjectPaneState().regionId).toBe(A.id);
  });

  it("a requestReopen for another view is not the object pane's", () => {
    selectObject(A);
    window.dispatchEvent(new CustomEvent("taskpane:requestReopen", { detail: { viewId: "pivot-editor" } }));
    expect(getObjectPaneState().open).toBe(false);
  });
});

describe("File > New / Open", () => {
  it("closes the pane, drops the key and resets Core's painted container layouts", () => {
    selectObject(A);
    openObjectPane({ reason: "command" });
    emitAppEvent(AppEvents.AFTER_NEW);
    expect(getObjectPaneState().open).toBe(false);
    expect(panes.keys).not.toContain("object");
    expect(h.resetLayouts).toHaveBeenCalledTimes(1);
    emitAppEvent(AppEvents.AFTER_OPEN);
    expect(h.resetLayouts).toHaveBeenCalledTimes(2);
  });
});
