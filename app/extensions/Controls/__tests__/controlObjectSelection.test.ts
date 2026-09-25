//! FILENAME: app/extensions/Controls/__tests__/controlObjectSelection.test.ts
// PURPOSE: A keyboard (or script) selection of a control SELECTS it and does
//          nothing else: a run-mode button is not pressed, no script hears a
//          click, and the Properties pane does not open.
// CONTEXT: The only other route to a selected control is Core's
//          `floatingObject:selected`, and Controls' handler for it is a CLICK
//          handler — in run mode it emits `button:clicked` and runs the
//          button's macro, it emits `shape:clicked`, and it opens the
//          Properties pane. A canvas sheet's Tab cycling that went through that
//          event would press every macro button it passed. So the assertions
//          are on what must NOT happen, observed at the places it would show:
//          the app-event bus, the task-pane opener, and the DOM event itself.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const emitted: Array<{ name: string; detail: unknown }> = [];
const openTaskPane = vi.fn();

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: (name: string, detail?: unknown) => {
    emitted.push({ name, detail });
  },
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openTaskPane: (...args: unknown[]) => openTaskPane(...args),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
}));

import { AppEvents } from "@api";
import type { GridRegion } from "@api/gridOverlays";
import {
  deselectAllObjects,
  getSelectedObjectRegion,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  selectObject,
} from "@api/objectSelection";
import {
  createControlSelectionProvider,
  registerControlObjectSelection,
} from "../lib/controlObjectSelection";
import {
  addFloatingControl,
  getAllFloatingControls,
  groupControls,
  removeFloatingControl,
  resetFloatingStore,
} from "../lib/floatingStore";
import {
  deselectFloatingControl,
  getSelectedFloatingControls,
  isFloatingControlSelected,
} from "../Button/floatingSelection";
import { getDesignMode } from "../lib/designMode";

const BUTTON = "control-0-1-1";
const SHAPE = "control-0-3-3";
const PIC_A = "control-0-5-5";
const PIC_B = "control-0-6-6";

function region(id: string, controlType: string): GridRegion {
  return {
    id,
    type: "floating-control",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 10, y: 10, width: 80, height: 28 },
    data: { sheetIndex: 0, row: 1, col: 1, controlType },
  };
}

function add(id: string, controlType: string): void {
  const [, s, r, c] = id.split("-").map(Number);
  addFloatingControl({
    id,
    sheetIndex: s,
    row: r,
    col: c,
    x: 10,
    y: 10,
    width: 80,
    height: 28,
    controlType,
  });
}

const domSelected: Event[] = [];
const onDomSelected = (e: Event) => domSelected.push(e);

beforeEach(() => {
  resetObjectSelectionProviders();
  for (const ctrl of getAllFloatingControls()) removeFloatingControl(ctrl.id);
  resetFloatingStore();
  deselectFloatingControl();
  emitted.length = 0;
  domSelected.length = 0;
  openTaskPane.mockClear();
  window.addEventListener("floatingObject:selected", onDomSelected);
  add(BUTTON, "button");
  add(SHAPE, "shape");
  add(PIC_A, "image");
  add(PIC_B, "image");
});

afterEach(() => {
  window.removeEventListener("floatingObject:selected", onDomSelected);
});

/** Let any promise-deferred side effect (a lazily imported pane opener) run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("keyboard selection of a RUN-MODE button", () => {
  it("is run mode (the precondition the whole test depends on)", () => {
    expect(getDesignMode()).toBe(false);
  });

  it("selects it, and presses nothing", async () => {
    registerControlObjectSelection();
    expect(selectObject(region(BUTTON, "button"))).toBe(true);
    await settle();

    expect(isFloatingControlSelected(BUTTON)).toBe(true);
    // No click reached anything a script or a macro listens to.
    const names = emitted.map((e) => e.name);
    expect(names).not.toContain("button:clicked");
    expect(names).not.toContain("shape:clicked");
    // It was not routed through the mouse event whose handler runs buttons.
    expect(domSelected).toHaveLength(0);
    // The Properties pane stayed shut.
    expect(openTaskPane).not.toHaveBeenCalled();
    // It did repaint, so the selection is visible.
    expect(names).toContain(AppEvents.GRID_REFRESH);
  });

  it("a shape is selected without `shape:clicked` reaching its object script", async () => {
    registerControlObjectSelection();
    selectObject(region(SHAPE, "shape"));
    await settle();
    expect(isFloatingControlSelected(SHAPE)).toBe(true);
    expect(emitted.map((e) => e.name)).not.toContain("shape:clicked");
    expect(openTaskPane).not.toHaveBeenCalled();
  });
});

describe("the provider's selection semantics", () => {
  it("replaces the selection: one object per keyboard step", () => {
    const p = createControlSelectionProvider();
    p.select(region(BUTTON, "button"));
    p.select(region(SHAPE, "shape"));
    expect([...getSelectedFloatingControls()]).toEqual([SHAPE]);
    expect(p.isSelected(region(SHAPE, "shape"))).toBe(true);
    expect(p.isSelected(region(BUTTON, "button"))).toBe(false);
  });

  it("expands a grouped control to its whole group (the object-menu rule)", () => {
    groupControls([PIC_A, PIC_B]);
    const p = createControlSelectionProvider();
    p.select(region(PIC_A, "image"));
    expect(new Set(getSelectedFloatingControls())).toEqual(new Set([PIC_A, PIC_B]));
  });

  it("ignores a region whose control is not in the store", () => {
    const p = createControlSelectionProvider();
    p.select(region("control-0-99-99", "button"));
    expect(getSelectedFloatingControls().size).toBe(0);
  });

  it("deselectAll clears, and does not repaint when there was nothing to clear", () => {
    const p = createControlSelectionProvider();
    p.deselectAll();
    expect(emitted).toHaveLength(0);
    p.select(region(BUTTON, "button"));
    emitted.length = 0;
    p.deselectAll();
    expect(getSelectedFloatingControls().size).toBe(0);
    expect(emitted.map((e) => e.name)).toEqual([AppEvents.GRID_REFRESH]);
  });

  it("through the seam: selecting a control deselects the other families", () => {
    registerControlObjectSelection();
    const otherDeselect = vi.fn();
    registerObjectSelectionProvider({
      types: ["chart"],
      isSelected: () => false,
      select: () => undefined,
      deselectAll: otherDeselect,
    });
    selectObject(region(BUTTON, "button"));
    expect(otherDeselect).toHaveBeenCalledTimes(1);
    expect(getSelectedObjectRegion([region(SHAPE, "shape"), region(BUTTON, "button")])?.id).toBe(BUTTON);
    deselectAllObjects();
    expect(getSelectedFloatingControls().size).toBe(0);
  });
});
