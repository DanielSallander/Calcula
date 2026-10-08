//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasInsertSection.test.tsx
// PURPOSE: The old Insert group's controls, after the Canvas tab became Power
//          BI's report authoring (CONTRACT-CANVAS 2026-10-08): the Insert
//          heroes were split into Visuals and Elements, and the ids live E2E
//          specs and the contract press are KEPT on the control that does the
//          same thing. Driven end to end through the real visual catalogue,
//          down to the kind `insertOnCanvas` is asked for:
//            - PivotTable is the Matrix row (`canvas-insert-pivot`), a pivot;
//            - Slicer is the Slicer row (`canvas-insert-slicer`), a slicer;
//            - Text Box, Image, Floating Grid are Elements heroes;
//            - Shape and Button are the FACES of the Shapes / Buttons splits
//              (a rectangle, a blank button).
//          Each is locked on a subscribed canvas and absent off a canvas.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false, activeIndex: 2, version: 1 },
  insertOnCanvas: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("../lib/insertOnCanvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/insertOnCanvas")>()),
  insertOnCanvas: (...a: unknown[]) => h.insertOnCanvas(...a),
}));
vi.mock("@api/controlsService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/controlsService")>()),
  getControlsProvider: () => ({ listShapeCatalog: () => [] }),
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { CanvasVisualsSection } from "../components/CanvasVisualsSection";
import { CanvasElementsSection } from "../components/CanvasElementsSection";
import { byTestId, click, flush, maybeTestId, mountHarness, type Harness } from "./tabHarness";

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

let hn: Harness;

beforeEach(() => {
  h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: false, activeIndex: 2, version: 1 };
  h.insertOnCanvas.mockClear();
  hn = mountHarness();
});

afterEach(() => hn.unmount());

function render(): void {
  hn.render(
    <div>
      <CanvasVisualsSection {...PROPS} />
      <CanvasElementsSection {...PROPS} />
    </div>,
    "band",
  );
}

/** The kept id, its accessible words, and the insert it must ask for. */
const KEPT: ReadonlyArray<[string, string, unknown[]]> = [
  ["canvas-insert-pivot", "Matrix", ["pivot", {}]],
  ["canvas-insert-slicer", "Slicer", ["slicer"]],
  ["canvas-insert-textBox", "Text Box", ["textBox"]],
  ["canvas-insert-picture", "Image", ["picture"]],
  ["canvas-insert-floatingGrid", "Floating Grid", ["floatingGrid"]],
  ["canvas-insert-shape", "Shapes", ["shape", { shapeId: "rectangle" }]],
  ["canvas-insert-button", "Buttons", ["button", { button: "blank" }]],
];

describe("the kept Insert ids", () => {
  it.each(KEPT)("%s is still on the tab and inserts the same kind", async (id, words, call) => {
    render();
    const el = byTestId(id, hn.container);
    expect((el.getAttribute("aria-label") ?? "") + (el.textContent ?? "")).toContain(words);
    click(el);
    await flush();
    expect(h.insertOnCanvas).toHaveBeenCalledTimes(1);
    expect(h.insertOnCanvas.mock.calls[0]).toEqual(call);
  });

  it("the PivotTable insert (Matrix) sits among the visuals, right before Card -- Power BI's row 2", () => {
    render();
    const ids = [...hn.container.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"));
    expect(ids.indexOf("canvas-visual-card")).toBe(ids.indexOf("canvas-insert-pivot") + 1);
    expect(ids.indexOf("canvas-insert-pivot")).toBeLessThan(ids.indexOf("canvas-insert-slicer"));
  });

  it.each(KEPT)("%s is locked on a subscribed canvas", (id) => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render();
    const el = byTestId(id, hn.container);
    expect(el.disabled || el.getAttribute("aria-disabled") === "true").toBe(true);
    click(el);
    expect(h.insertOnCanvas).not.toHaveBeenCalled();
  });

  it("none of them is shown off a canvas", () => {
    h.snapshot = { active: null, activeSubscribed: false, activeIndex: 0, version: 1 };
    render();
    for (const [id] of KEPT) expect(maybeTestId(id, hn.container)).toBeNull();
  });
});
