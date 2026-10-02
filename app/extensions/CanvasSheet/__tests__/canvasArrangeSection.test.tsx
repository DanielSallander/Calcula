//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasArrangeSection.test.tsx
// PURPOSE: The Canvas tab's ARRANGE section, rendered: five heroes (Bring
//          Forward, Send Backward, Align -- menus -- Lock, and Size & Position,
//          BUG-0258 phase 5b, which opens the Size and Position dialog for the
//          selection's PRIMARY object through @api/objectPosition); disabled with
//          the SUBSCRIBED note on a pulled canvas and with the "select first"
//          note when nothing is selected; Distribute disabled below three
//          objects; the menus run the right commands; Lock reads "Unlock"
//          when every selected object is locked; and the section sits in the
//          Canvas tab's panel definition.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false },
  selected: [] as Array<{ id: string }>,
  locked: false,
  restack: vi.fn(async (_c: string) => true),
  lock: vi.fn(async (_l: boolean) => true),
  align: vi.fn(async (_e: string) => 0),
  distribute: vi.fn(async (_a: string) => 0),
  primary: null as unknown,
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("@api/objectSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectSelection")>()),
  getSelectedObjectRegions: () => h.selected,
  getPrimaryObjectRegion: () => h.primary,
  onObjectSelectionChanged: () => () => {},
}));
vi.mock("../lib/zOrderStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/zOrderStore")>()),
  allLocked: () => h.locked,
  restackObjects: (c: string) => h.restack(c),
  setObjectsLocked: (l: boolean) => h.lock(l),
}));
vi.mock("../lib/arrange", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/arrange")>()),
  alignSelectedObjects: (e: string) => h.align(e),
  distributeSelectedObjects: (a: string) => h.distribute(a),
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { CanvasArrangeSection } from "../components/CanvasArrangeSection";
import { CanvasPanelDefinition } from "../components/CanvasTabSections";
import { NOTHING_SELECTED_NOTE, SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import type { GridRegion } from "@api/gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import { registerSizeAndPositionOpener, resetObjectPosition } from "@api/objectPosition";

const PRIMARY: GridRegion = {
  id: "chart-b",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { chartId: "b" },
  floating: { x: 64, y: 64, width: 320, height: 200 },
};
const opened: string[] = [];
let offOpener: () => void = () => {};
let offProvider: () => void = () => {};

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: false };
  h.selected = [{ id: "a" }, { id: "b" }];
  h.locked = false;
  h.primary = PRIMARY;
  for (const f of [h.restack, h.lock, h.align, h.distribute]) f.mockClear();
  resetObjectPosition();
  resetObjectGeometryProviders();
  opened.length = 0;
  offProvider = registerObjectGeometryProvider({ types: ["chart"], commit: async () => {} });
  offOpener = registerSizeAndPositionOpener((r) => opened.push(r.id));
  Reflect.set(globalThis, "ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  offOpener();
  offProvider();
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(): void {
  act(() => {
    root.render(<CanvasArrangeSection {...PROPS} />);
  });
}

const byTestId = (id: string, scope: ParentNode = document): HTMLButtonElement => {
  const el = scope.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
};

function click(el: HTMLElement): void {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function openAndRun(trigger: string, item: string): Promise<void> {
  click(byTestId(trigger, container));
  click(byTestId(item));
  // onSelect runs after the menu closes.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the Arrange section", () => {
  it("is in the Canvas tab, after Insert", () => {
    const ids = CanvasPanelDefinition.sections.map((s) => s.id);
    expect(ids.indexOf("canvas-tab.arrange")).toBe(ids.indexOf("canvas-tab.insert") + 1);
  });

  it("five heroes, enabled with a selection", () => {
    render();
    for (const id of ["canvas-arrange-forward", "canvas-arrange-backward", "canvas-arrange-align", "canvas-arrange-lock", "canvas-arrange-size-position"]) {
      expect(byTestId(id, container).disabled).toBe(false);
    }
  });

  it("the menus run the right commands", async () => {
    render();
    await openAndRun("canvas-arrange-forward", "canvas-arrange-bring-to-front");
    expect(h.restack).toHaveBeenCalledWith("bringToFront");
    await openAndRun("canvas-arrange-backward", "canvas-arrange-send-backward");
    expect(h.restack).toHaveBeenCalledWith("sendBackward");
    await openAndRun("canvas-arrange-align", "canvas-arrange-align-middle");
    expect(h.align).toHaveBeenCalledWith("middle");
  });

  it("Distribute is disabled below three objects, enabled at three", async () => {
    render();
    click(byTestId("canvas-arrange-align", container));
    expect(byTestId("canvas-arrange-distribute-horizontal").disabled).toBe(true);
    act(() => root.unmount());
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    h.selected = [{ id: "a" }, { id: "b" }, { id: "c" }];
    render();
    await openAndRun("canvas-arrange-align", "canvas-arrange-distribute-vertical");
    expect(h.distribute).toHaveBeenCalledWith("vertical");
  });

  it("Lock toggles, and reads Unlock when every selected object is locked", () => {
    render();
    const lock = byTestId("canvas-arrange-lock", container);
    expect(lock.textContent).toContain("Lock");
    click(lock);
    expect(h.lock).toHaveBeenCalledWith(true);
    h.locked = true;
    render();
    expect(byTestId("canvas-arrange-lock", container).textContent).toContain("Unlock");
    click(byTestId("canvas-arrange-lock", container));
    expect(h.lock).toHaveBeenLastCalledWith(false);
  });

  it("Size & Position opens the dialog for the selection's PRIMARY object (BUG-0258 phase 5b)", () => {
    render();
    const button = byTestId("canvas-arrange-size-position", container);
    expect(button.textContent).toContain("Size & Position");
    click(button);
    expect(opened).toEqual([PRIMARY.id]);
  });

  it("Size & Position is disabled when no dialog can open for the primary (none installed, or no provider)", () => {
    offOpener();
    render();
    expect(byTestId("canvas-arrange-size-position", container).disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    offOpener = registerSizeAndPositionOpener((r) => opened.push(r.id));
    h.primary = { ...PRIMARY, type: "no-provider" };
    render();
    expect(byTestId("canvas-arrange-size-position", container).disabled).toBe(true);
    expect(opened).toEqual([]);
  });

  it("nothing selected: every hero is disabled, with the reason", () => {
    h.selected = [];
    h.primary = null;
    render();
    for (const id of ["canvas-arrange-forward", "canvas-arrange-backward", "canvas-arrange-align", "canvas-arrange-lock", "canvas-arrange-size-position"]) {
      expect(byTestId(id, container).disabled).toBe(true);
    }
    expect(NOTHING_SELECTED_NOTE).toMatch(/Select/);
  });

  it("a SUBSCRIBED canvas: every hero is disabled (the layout is the publisher's)", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render();
    for (const id of ["canvas-arrange-forward", "canvas-arrange-backward", "canvas-arrange-align", "canvas-arrange-lock", "canvas-arrange-size-position"]) {
      expect(byTestId(id, container).disabled).toBe(true);
    }
    expect(SUBSCRIBED_NOTE).toMatch(/publisher/);
  });

  it("is not shown off a canvas", () => {
    h.snapshot = { active: null, activeSubscribed: false };
    render();
    expect(container.querySelector('[data-testid="canvas-arrange-align"]')).toBeNull();
  });
});
