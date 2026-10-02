//! FILENAME: app/extensions/BuiltIn/ObjectPosition/__tests__/SizePositionDialog.test.tsx
// PURPOSE: The Size and Position dialog, rendered (BUG-0258 design phase 5b):
//          four boxes edited and OK -> EXACTLY ONE `commitObjectGeometry` call
//          with ONE change, labelled "Size and Position" (one undo step);
//          Cancel and an unchanged OK commit nothing; a double OK commits once;
//          Width/Height disabled for a family that cannot resize; every box
//          disabled, with the reason and only a Close button, for a locked
//          object, a subscribed page and a run-mode button; a canvas page keeps
//          the typed position on it; a vanished object commits nothing.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`. The
//          seam's rules (@api/objectPosition) and the geometry registry are the
//          REAL ones; only the commit door is replaced, so the test sees what
//          the dialog asks the families to do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  regions: [] as unknown[],
  commit: vi.fn(async (_changes: unknown[], _label: string) => ({ committed: 1, refused: 0, skipped: 0 })),
  toast: vi.fn(),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  getGridRegions: () => h.regions,
}));
vi.mock("@api/objectGeometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectGeometry")>()),
  commitObjectGeometry: (changes: unknown[], label: string) => h.commit(changes, label),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (...a: unknown[]) => h.toast(...a),
}));

import type { GridRegion } from "@api/gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { setDesignMode } from "@api/designMode";
import {
  SIZE_AND_POSITION_UNDO_LABEL,
  SIZE_POSITION_DESIGN_MODE,
  SIZE_POSITION_FIXED_SIZE,
  SIZE_POSITION_LOCKED,
  SIZE_POSITION_SUBSCRIBED,
} from "@api/objectPosition";
import { SizePositionDialog } from "../components/SizePositionDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SLICER: GridRegion = {
  id: "slicer-s1",
  type: "slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { slicerId: "s1" },
  floating: { x: 64, y: 32, width: 200, height: 100 },
};
const GRID: GridRegion = { ...SLICER, id: "fr-g1", type: "floating-range", data: { frId: "g1" } };
const BUTTON: GridRegion = { ...SLICER, id: "ctl-1", type: "floating-control", data: { controlType: "button", movable: false } };

let surface: LayoutSurface | null = null;
let container: HTMLDivElement;
let root: Root;
const cleanups: Array<() => void> = [];
const onClose = vi.fn();

beforeEach(() => {
  h.regions = [SLICER, GRID, BUTTON];
  h.commit.mockClear();
  h.toast.mockClear();
  onClose.mockClear();
  surface = null;
  setDesignMode(false);
  resetObjectGeometryProviders();
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
  cleanups.push(registerObjectGeometryProvider({ types: ["slicer"], commit: async () => {} }));
  cleanups.push(registerObjectGeometryProvider({ types: ["floating-range"], canResize: () => false, commit: async () => {} }));
  cleanups.push(registerObjectGeometryProvider({ types: ["floating-control"], commit: async () => {} }));
  Reflect.set(globalThis, "ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  while (cleanups.length) cleanups.pop()!();
  setDesignMode(false);
});

function open(regionId: string): void {
  act(() => {
    root.render(<SizePositionDialog isOpen onClose={onClose} data={{ regionId }} />);
  });
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
};
const maybe = (id: string) => document.querySelector(`[data-testid="${id}"]`);

/** Type `text` the way React sees it: set the native value, fire input. */
function type(id: string, text: string): void {
  const el = byTestId<HTMLInputElement>(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    el.focus();
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(id: string): Promise<void> {
  await act(async () => {
    byTestId(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the Size and Position dialog", () => {
  it("starts at the object's rectangle, in px, with the first box focused", () => {
    open(SLICER.id);
    expect(byTestId<HTMLInputElement>("size-position-x").value).toBe("64");
    expect(byTestId<HTMLInputElement>("size-position-y").value).toBe("32");
    expect(byTestId<HTMLInputElement>("size-position-width").value).toBe("200");
    expect(byTestId<HTMLInputElement>("size-position-height").value).toBe("100");
    expect(document.activeElement).toBe(byTestId("size-position-x"));
    expect(maybe("size-position-reason")).toBeNull();
  });

  it("all four edited, then OK: EXACTLY ONE commit with ONE change, labelled 'Size and Position', then it closes", async () => {
    open(SLICER.id);
    type("size-position-x", "480");
    type("size-position-y", "256");
    type("size-position-width", "320");
    type("size-position-height", "240");
    expect(h.commit, "a box committed on its own while being typed in").not.toHaveBeenCalled();
    await click("size-position-ok");
    expect(h.commit).toHaveBeenCalledTimes(1);
    const [changes, label] = h.commit.mock.calls[0];
    expect(label).toBe(SIZE_AND_POSITION_UNDO_LABEL);
    expect(label).toBe("Size and Position");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ region: SLICER, x: 480, y: 256, width: 320, height: 240 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a double OK (and Enter) commits once", async () => {
    open(SLICER.id);
    type("size-position-x", "96");
    await act(async () => {
      const ok = byTestId("size-position-ok");
      ok.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      ok.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it("Cancel commits nothing; an unchanged OK commits nothing (and closes)", async () => {
    open(SLICER.id);
    type("size-position-x", "480");
    await click("size-position-cancel");
    expect(h.commit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);
    onClose.mockClear();
    open(SLICER.id);
    type("size-position-x", "64");
    await click("size-position-ok");
    expect(h.commit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a family that cannot resize (a floating grid): Width/Height disabled, the reason said, the size kept", async () => {
    open(GRID.id);
    expect(byTestId<HTMLInputElement>("size-position-x").disabled).toBe(false);
    expect(byTestId<HTMLInputElement>("size-position-width").disabled).toBe(true);
    expect(byTestId<HTMLInputElement>("size-position-height").disabled).toBe(true);
    expect(byTestId("size-position-reason").textContent).toBe(SIZE_POSITION_FIXED_SIZE);
    type("size-position-x", "300");
    await click("size-position-ok");
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit.mock.calls[0][0][0]).toMatchObject({ x: 300, y: 32, width: 200, height: 100 });
  });

  for (const c of [
    { name: "a LOCKED object", setup: () => (surface = canvas({ isLocked: () => true })), id: SLICER.id, reason: SIZE_POSITION_LOCKED },
    { name: "a SUBSCRIBED page", setup: () => (surface = canvas({ editable: false })), id: SLICER.id, reason: SIZE_POSITION_SUBSCRIBED },
    { name: "a RUN-MODE button", setup: () => undefined, id: BUTTON.id, reason: SIZE_POSITION_DESIGN_MODE },
  ]) {
    it(`${c.name}: every box disabled, the reason shown, only Close -- and nothing committed`, async () => {
      c.setup();
      open(c.id);
      for (const box of ["x", "y", "width", "height"]) {
        expect(byTestId<HTMLInputElement>(`size-position-${box}`).disabled, `${box} is editable`).toBe(true);
      }
      expect(byTestId("size-position-reason").textContent).toBe(c.reason);
      expect(maybe("size-position-ok"), "an OK on a dialog that cannot write").toBeNull();
      await click("size-position-close");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(h.commit).not.toHaveBeenCalled();
    });
  }

  it("the button its family re-publishes as movable (Design Mode on) opens editable", () => {
    setDesignMode(true);
    h.regions = [{ ...BUTTON, data: { controlType: "button", movable: true } }];
    open(BUTTON.id);
    expect(byTestId<HTMLInputElement>("size-position-x").disabled).toBe(false);
    expect(maybe("size-position-reason")).toBeNull();
  });

  it("on a canvas the typed position is kept on the page (no snap), and the page is named", async () => {
    surface = canvas();
    open(SLICER.id);
    expect(byTestId("size-position-page").textContent).toContain("1280 x 720");
    type("size-position-x", "5000");
    type("size-position-y", "37");
    await click("size-position-ok");
    expect(h.commit.mock.calls[0][0][0]).toMatchObject({ x: 1080, y: 37, width: 200, height: 100 });
  });

  // THE RECHECK AT OK (M7 review). The dialog reads the object's availability
  // when it RENDERS and subscribes to no change, so an object that stops being
  // movable while the dialog is open -- a redo of Lock, a script, its page
  // subscribed, Design Mode turned off -- still shows its OK. The OK re-reads
  // availability itself; this is the only thing that refuses there.
  for (const c of [
    { name: "LOCKED", change: () => (surface = canvas({ isLocked: () => true })) },
    { name: "on a SUBSCRIBED page", change: () => (surface = canvas({ editable: false })) },
    { name: "re-published IMMOVABLE (movable: false)", change: () => (h.regions = [{ ...SLICER, data: { slicerId: "s1", movable: false } }]) },
  ]) {
    it(`an object that became ${c.name} while the dialog was open: OK commits nothing and closes`, async () => {
      surface = canvas();
      open(SLICER.id);
      type("size-position-x", "480");
      expect(maybe("size-position-ok"), "precondition: the dialog opened editable").not.toBeNull();
      // The change lands with NO re-render: the OK still shows.
      c.change();
      await click("size-position-ok");
      expect(h.commit, `OK committed a move of an object that is now ${c.name}`).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  }

  it("an object that vanished while the dialog was open: nothing committed, the user told", async () => {
    open(SLICER.id);
    type("size-position-x", "480");
    h.regions = [];
    await click("size-position-ok");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opened for an object that is not published: says so and offers Close", () => {
    open("slicer-missing");
    expect(byTestId("size-position-reason").textContent).toMatch(/no longer on this sheet/);
    expect(maybe("size-position-x")).toBeNull();
  });
});

function canvas(over: Partial<LayoutSurface> = {}): LayoutSurface {
  return { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true, ...over };
}
