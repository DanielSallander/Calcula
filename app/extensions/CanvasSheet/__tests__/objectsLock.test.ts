//! FILENAME: app/extensions/CanvasSheet/__tests__/objectsLock.test.ts
// PURPOSE: View > Lock Objects (Power BI's "Lock all objects on the canvas so
//          that they can't be moved or resized"), enforced in the UI on top of
//          the backend's refusal (rust-canvas lane, `CanvasLayout::objects_locked`):
//            - the layout surface answers LOCKED for every object on the page,
//              so Core arms no drag, shows no grip and no resize handle;
//            - align / distribute / nudge / group drag treat every object as
//              immovable (`isArrangeMovable`);
//            - a drag or a nudge ATTEMPT is told why, in ONE toast per gesture
//              (an auto-repeating arrow key is one gesture, not thirty);
//            - the per-object padlock mark stays per-object: the page lock is
//              shown by its own toggle, not by a padlock on every selection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CanvasLayout, SheetsResult } from "@api";

const getSheets = vi.fn<() => Promise<SheetsResult>>();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: () => getSheets(),
}));

let provenance: Array<{ sheetId: string; role: string }> = [];
vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getSheetProvenance: async () => provenance,
}));

let gridSnapshot: Record<string, unknown> | null = null;
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => gridSnapshot,
}));

vi.mock("@api/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/keybindings")>()),
  isGridFocused: () => true,
}));

const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string) => toasts.push(message),
}));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { registerObjectGeometryProvider, resetObjectGeometryProviders, type ObjectGeometryChange } from "@api/objectGeometry";
import { registerLayoutSurfaceProvider, objectGeometryEditable } from "@api/layoutSurface";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { isSubscribedCanvas, refreshCanvasProvenance, refreshCanvasSheets, resetCanvasSheetStore } from "../lib/canvasSheetStore";
import { canvasLayoutSurface, canvasLayoutSurfaceProvider } from "../lib/layoutSurfaceProvider";
import { isLockedOnActiveCanvas } from "../lib/canvasLocks";
import { isArrangeMovable } from "../lib/arrange";
import { nudgeSelection, resetCanvasObjectNudge } from "../lib/objectNudge";
import {
  OBJECTS_LOCKED_NOTE,
  OBJECTS_LOCKED_NOTICE_MS,
  activeCanvasObjectsLocked,
  installObjectsLockedNotice,
  resetObjectsLockedNotice,
  tellObjectsLocked,
} from "../lib/objectsLock";

const CANVAS = 1;

async function onCanvas(over: Partial<CanvasLayout> = {}): Promise<void> {
  getSheets.mockResolvedValueOnce({
    activeIndex: CANVAS,
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "ws-0" },
      {
        index: CANVAS,
        name: "Page",
        visibility: "visible",
        sheetId: "cv-1",
        kind: "canvas",
        canvasLayout: { ...defaultCanvasLayout(), snapToGrid: false, ...over },
      },
    ],
  });
  await refreshCanvasSheets();
  gridSnapshot = { surface: "canvas", sheetContext: { activeSheetIndex: CANVAS }, zoom: 1 };
}

function region(id: string, x: number, y: number): GridRegion {
  return { id, type: "shape", startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x, y, width: 100, height: 50 }, data: { key: id } };
}

function family(): ObjectSelectionProvider {
  const held = new Set<string>();
  return {
    types: ["shape"],
    isSelected: (r) => held.has(r.id),
    select: (r) => {
      held.clear();
      held.add(r.id);
    },
    deselectAll: () => held.clear(),
    addToSelection: (r) => {
      held.add(r.id);
    },
    refOf: (r) => ({ kind: "control", id: r.id }),
  };
}

const a = region("a", 100, 100);
const b = region("b", 300, 100);
const previews: ObjectGeometryChange[][] = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  resetCanvasSheetStore();
  resetObjectSelectionProviders();
  resetObjectGeometryProviders();
  resetCanvasObjectNudge();
  resetObjectsLockedNotice();
  getSheets.mockReset();
  provenance = [];
  toasts.length = 0;
  previews.length = 0;
  gridSnapshot = null;
  cleanups.push(
    registerObjectSelectionProvider(family()),
    registerObjectGeometryProvider({
      types: ["shape"],
      preview: (changes) => {
        previews.push([...changes]);
      },
      commit: async () => {},
    }),
    registerLayoutSurfaceProvider(canvasLayoutSurfaceProvider),
  );
  setGridRegions([a, b]);
});

afterEach(() => {
  resetCanvasObjectNudge();
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()!();
  setGridRegions([]);
});

describe("the surface answer", () => {
  it("Lock Objects ON: every object is locked -- named in `locked` or not", async () => {
    await onCanvas({ objectsLocked: true });
    const surface = canvasLayoutSurface(CANVAS)!;
    expect(surface.isLocked!(a)).toBe(true);
    expect(surface.isLocked!(b)).toBe(true);
    // Core's one answer for "may this move" follows.
    expect(objectGeometryEditable(CANVAS, a, true)).toBe(false);
    expect(activeCanvasObjectsLocked()).toBe(true);
  });

  it("Lock Objects OFF: only the objects the layout names are locked (the per-object Lock)", async () => {
    await onCanvas({ locked: [{ kind: "control", id: "a" }] });
    const surface = canvasLayoutSurface(CANVAS)!;
    expect(surface.isLocked!(a)).toBe(true);
    expect(surface.isLocked!(b)).toBe(false);
    expect(activeCanvasObjectsLocked()).toBe(false);
  });

  it("the arrange verbs see every object as immovable while it is on", async () => {
    await onCanvas({ objectsLocked: true });
    expect(isArrangeMovable(a)).toBe(false);
    expect(isArrangeMovable(b)).toBe(false);
  });

  // Review finding (2026-10-08): the surface said "locked" for every object
  // and nothing more, so Size & Position told the user "This object is locked.
  // Unlock it" about an object with no lock of its own. The surface now names
  // the PAGE lock with the page's own sentence (@api/layoutSurface
  // pageLockedReason), which @api/objectPosition shows instead.
  it("Lock Objects ON: the surface names the page lock in the page's own words", async () => {
    await onCanvas({ objectsLocked: true });
    expect(canvasLayoutSurface(CANVAS)!.pageLockedReason).toBe(OBJECTS_LOCKED_NOTE);
  });

  it("Lock Objects OFF: no page lock is named, even with per-object locks", async () => {
    await onCanvas({ locked: [{ kind: "control", id: "a" }] });
    expect(canvasLayoutSurface(CANVAS)!.pageLockedReason ?? "").toBe("");
  });

  it("the padlock mark stays per-object (the page lock has its own toggle)", async () => {
    await onCanvas({ objectsLocked: true });
    expect(isLockedOnActiveCanvas(a)).toBe(false);
  });
});

describe("the nudge on a locked page", () => {
  it("moves nothing and says why, ONCE for a burst of keystrokes", async () => {
    await onCanvas({ objectsLocked: true });
    setObjectSelectionSet([a]);
    for (let i = 0; i < 5; i++) expect(nudgeSelection("right")).toEqual({ dx: 0, dy: 0 });
    expect(previews).toEqual([]);
    expect(toasts).toEqual([OBJECTS_LOCKED_NOTE]);
  });

  it("an unlocked page nudges as before and says nothing", async () => {
    await onCanvas();
    setObjectSelectionSet([a]);
    expect(nudgeSelection("right")).toEqual({ dx: 1, dy: 0 });
    expect(toasts).toEqual([]);
  });

  it("a per-object lock alone stays silent (the padlock already says it)", async () => {
    await onCanvas({ locked: [{ kind: "control", id: "a" }] });
    setObjectSelectionSet([a]);
    nudgeSelection("right");
    expect(toasts).toEqual([]);
  });
});

describe("the notice", () => {
  it("names the menu path the backend's refusal names, and how to undo it", () => {
    expect(OBJECTS_LOCKED_NOTE).toContain("Canvas > View > Lock Objects");
    expect(OBJECTS_LOCKED_NOTE).toMatch(/moved or resized/);
  });

  // Review finding (2026-10-08): the quiet window ran from the last SHOWN
  // toast, so a held arrow key (auto-repeat ~30/s) re-armed it every 2 s and
  // stacked a fresh 5 s toast each time. The window now SLIDES: any attempt
  // inside it, told or not, extends it, so one continuous gesture is one toast.
  it("a held arrow key (auto-repeat for 5 s) is ONE toast, not one every quiet interval", () => {
    vi.useFakeTimers();
    for (let t = 0; t < 5000; t += 33) {
      vi.setSystemTime(1_000_000 + t);
      tellObjectsLocked();
    }
    expect(toasts).toHaveLength(1);
    // Released, then pressed again after the quiet interval: told again.
    vi.setSystemTime(1_000_000 + 5000 + OBJECTS_LOCKED_NOTICE_MS + 1);
    tellObjectsLocked();
    expect(toasts).toHaveLength(2);
  });

  it("is said once per gesture: again after the quiet interval, not before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    tellObjectsLocked();
    tellObjectsLocked();
    expect(toasts).toHaveLength(1);
    vi.setSystemTime(1_000_000 + OBJECTS_LOCKED_NOTICE_MS + 1);
    tellObjectsLocked();
    expect(toasts).toHaveLength(2);
  });
});

describe("a drag attempt on a locked page", () => {
  // Core measures a press relative to the grid area, in logical px; jsdom
  // puts the area at (0, 0), so at zoom 1 a client point IS a canvas point.
  let area: HTMLDivElement;

  function press(x: number, y: number, zone = "frame"): void {
    window.dispatchEvent(
      new CustomEvent("floatingObject:selected", {
        detail: { regionId: "a", regionType: "shape", zone, canvasX: x, canvasY: y },
      }),
    );
  }
  function move(x: number, y: number, buttons = 1): void {
    area.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons, bubbles: true }));
  }
  function release(): void {
    area.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
  }

  let uninstall: Array<() => void> = [];
  beforeEach(() => {
    area = document.createElement("div");
    area.setAttribute("data-grid-area", "");
    document.body.appendChild(area);
    uninstall = installObjectsLockedNotice();
  });
  afterEach(() => {
    for (const u of uninstall) u();
    area.remove();
  });

  it("the zoom is applied: 2 screen px at 200% is 1 logical px, still a click", async () => {
    await onCanvas({ objectsLocked: true });
    gridSnapshot = { ...gridSnapshot!, zoom: 2 };
    press(100, 100);
    move(204, 204);
    expect(toasts).toEqual([]);
    move(260, 260);
    expect(toasts).toEqual([OBJECTS_LOCKED_NOTE]);
  });

  it("a frame press that DRAGS past the click threshold is told once", async () => {
    await onCanvas({ objectsLocked: true });
    press(200, 200);
    move(201, 201); // inside the 3px dead zone: a click so far
    expect(toasts).toEqual([]);
    move(210, 200);
    move(240, 220);
    release();
    expect(toasts).toEqual([OBJECTS_LOCKED_NOTE]);
  });

  it("a plain click (no travel) is a selection, and says nothing", async () => {
    await onCanvas({ objectsLocked: true });
    press(200, 200);
    release();
    move(260, 260, 0);
    expect(toasts).toEqual([]);
  });

  it("a press on an object's CONTENT (a slicer item, a button) is not a drag", async () => {
    await onCanvas({ objectsLocked: true });
    press(200, 200, "content");
    move(260, 260);
    expect(toasts).toEqual([]);
  });

  // Review finding (2026-10-08): on a SUBSCRIBED page whose publisher turned
  // Lock Objects on, a drag told the reader to "Turn Lock Objects off" -- a
  // toggle that is disabled for them. The page is not theirs to edit at all
  // (the surface is not editable), so the lock is not the reason and the
  // lock notice is not said.
  it("a SUBSCRIBED page the publisher locked is never told to turn the lock off", async () => {
    provenance = [{ sheetId: "cv-1", role: "subscribed" }];
    await onCanvas({ objectsLocked: true });
    await refreshCanvasProvenance();
    expect(isSubscribedCanvas(CANVAS)).toBe(true);
    press(200, 200);
    move(260, 260);
    release();
    expect(toasts).toEqual([]);
  });

  it("an unlocked page is never told", async () => {
    await onCanvas();
    press(200, 200);
    move(260, 260);
    expect(toasts).toEqual([]);
  });

  it("a worksheet is never told, even when the store still holds a locked canvas", async () => {
    await onCanvas({ objectsLocked: true });
    gridSnapshot = { surface: "grid", sheetContext: { activeSheetIndex: 0 } };
    press(200, 200);
    move(260, 260);
    expect(toasts).toEqual([]);
  });

  it("uninstalled, it listens to nothing", async () => {
    for (const u of uninstall) u();
    uninstall = [];
    await onCanvas({ objectsLocked: true });
    press(200, 200);
    move(260, 260);
    expect(toasts).toEqual([]);
  });
});
