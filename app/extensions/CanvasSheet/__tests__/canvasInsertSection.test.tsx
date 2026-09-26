//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasInsertSection.test.tsx
// PURPOSE: The Canvas tab's Insert group, rendered: the PivotTable hero is in
//          the gallery, it inserts a PIVOT (not another kind), and it is locked
//          on a subscribed canvas like every other insert.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false },
  insertOnCanvas: vi.fn(async (_kind: string) => {}),
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("../lib/insertOnCanvas", () => ({
  insertOnCanvas: (kind: string) => h.insertOnCanvas(kind),
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { CanvasInsertSection } from "../components/CanvasTabSections";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.snapshot = { active: { index: 2, name: "Canvas1", layout: {} }, activeSubscribed: false };
  h.insertOnCanvas.mockClear();
  Reflect.set(globalThis, "ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => {
    root.render(<CanvasInsertSection {...PROPS} />);
  });
}

function pivotButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[data-testid="canvas-insert-pivot"]');
  if (!el) throw new Error("no PivotTable insert button");
  return el;
}

describe("the PivotTable insert", () => {
  it("is in the gallery, labelled PivotTable, and inserts a pivot", () => {
    render();
    const btn = pivotButton();
    expect(btn.textContent).toContain("PivotTable");
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(h.insertOnCanvas).toHaveBeenCalledTimes(1);
    expect(h.insertOnCanvas).toHaveBeenCalledWith("pivot");
  });

  it("sits beside the chart, before the filters", () => {
    render();
    const ids = [...container.querySelectorAll("[data-testid^='canvas-insert-']")].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(ids.indexOf("canvas-insert-pivot")).toBe(ids.indexOf("canvas-insert-chart") + 1);
    expect(ids.indexOf("canvas-insert-pivot")).toBeLessThan(ids.indexOf("canvas-insert-slicer"));
  });

  it("is locked on a subscribed canvas", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render();
    expect(pivotButton().disabled).toBe(true);
  });

  it("is not shown off a canvas", () => {
    h.snapshot = { active: null, activeSubscribed: false };
    render();
    expect(container.querySelector('[data-testid="canvas-insert-pivot"]')).toBeNull();
  });
});
