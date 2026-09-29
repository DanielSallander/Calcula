//! FILENAME: app/src/core/components/Grid/GridCanvas.documentReplaced.test.tsx
// PURPOSE: BUG-0155. When the WHOLE document is replaced without a window
//          reload, the grid must drop the cells it cached for the previous
//          document and fetch the new one's.
// CONTEXT: GridCanvas re-reads cell data only on `grid:refresh`, a sheet switch
//          (`sheet:normalSwitch` / `sheet:formulaModeSwitch`) or a scroll past
//          its buffered range. `announceBackendStateReplaced()` -- the one
//          helper every no-reload replacement calls (`calp_checkout`, the
//          file-api `newFile`/`openFileAtPath` the E2E harness and scripts use)
//          -- emitted none of those, so `needsFetch()` found the viewport
//          covered and the PREVIOUS document's cells stayed painted: observed in
//          the E2E harness as a canvas pivot's hidden-grid cells painted on the
//          new Sheet1 while `get_cells_in_rows` returned nothing.
//
//          Measured through the renderer's own input: `renderGrid` is mocked
//          and the `cells` map it is handed is what reaches the screen.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Cell = { row: number; col: number; display: string };

/** What the backend answers `get_viewport_cells` with, swapped per document. */
let backendCells: Cell[] = [];
/** When set, the next viewport fetch waits on this before answering. */
let gate: Promise<void> | null = null;
const getViewportCells = vi.fn(async (): Promise<Cell[]> => {
  const answer = backendCells;
  if (gate) {
    await gate;
  }
  return answer;
});
vi.mock("../../lib/tauri-api", () => ({
  getViewportCells: (...args: unknown[]) => (getViewportCells as (...a: unknown[]) => Promise<Cell[]>)(...args),
  getSpillRanges: async () => [],
}));

const renderGrid = vi.fn();
vi.mock("../../lib/gridRenderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gridRenderer")>();
  return { ...actual, renderGrid: (...args: unknown[]) => renderGrid(...args) };
});

import { GridCanvas } from "./GridCanvas";
import { announceBackendStateReplaced } from "../../lib/file-api";
import { DEFAULT_GRID_CONFIG, cellKey, type GridConfig, type Viewport } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG, totalRows: 1000, totalCols: 100 };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 20 };

/** The cells map the LAST paint was handed (renderGrid's 8th argument). */
function paintedCells(): Map<string, Cell> {
  const calls = renderGrid.mock.calls;
  expect(calls.length, "the grid never painted").toBeGreaterThan(0);
  return calls[calls.length - 1][7] as Map<string, Cell>;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

let root: Root;
let host: HTMLDivElement;
const restore: Array<() => void> = [];

beforeEach(() => {
  backendCells = [];
  gate = null;
  getViewportCells.mockClear();
  renderGrid.mockClear();
  // jsdom lays nothing out and has no 2D canvas: give the grid a size and a
  // context that accepts the calls `draw` makes around `renderGrid`.
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400, toJSON: () => ({}) } as DOMRect;
  };
  restore.push(() => {
    HTMLElement.prototype.getBoundingClientRect = rect;
  });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return { scale() {}, setTransform() {}, fillRect() {}, fillStyle: "" } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
  restore.push(() => {
    HTMLCanvasElement.prototype.getContext = getContext;
  });
  const RO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  restore.push(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  while (restore.length) restore.pop()!();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<GridCanvas config={CONFIG} viewport={VIEWPORT} selection={null} editing={null} />);
  });
  await settle();
}

describe("GridCanvas after a no-reload document replacement (BUG-0155)", () => {
  it("drops the previous document's cells and paints the new one's", async () => {
    backendCells = [{ row: 2, col: 3, display: "PIVOT" }];
    await mount();
    expect(paintedCells().get(cellKey(2, 3))?.display, "precondition: the old document painted").toBe("PIVOT");

    // The backend now holds a blank document; the frontend is told the way
    // every no-reload replacement tells it.
    backendCells = [];
    const fetchesBefore = getViewportCells.mock.calls.length;
    announceBackendStateReplaced();
    await settle();

    expect(getViewportCells.mock.calls.length, "the grid never asked the new document").toBeGreaterThan(fetchesBefore);
    expect(
      paintedCells().has(cellKey(2, 3)),
      "the previous document's cell is still painted on the new document",
    ).toBe(false);
  });

  it("a fetch in flight for the OLD document is not committed over the new one", async () => {
    backendCells = [{ row: 0, col: 0, display: "first" }];
    await mount();

    // A fetch for the old document is in flight when the replacement lands.
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    backendCells = [{ row: 5, col: 5, display: "OLD-IN-FLIGHT" }];
    await act(async () => {
      window.dispatchEvent(new Event("grid:refresh"));
    });
    backendCells = [{ row: 7, col: 1, display: "NEW" }];
    const paintsBefore = renderGrid.mock.calls.length;
    announceBackendStateReplaced();
    gate = null;
    release();
    await settle();

    // EVERY paint after the announcement, not only the last: a stale answer
    // committed and then overwritten by the re-fetch is still a frame of the
    // previous document on the new one.
    const after = renderGrid.mock.calls.slice(paintsBefore).map((c) => c[7] as Map<string, Cell>);
    expect(after.length, "the grid never repainted").toBeGreaterThan(0);
    expect(
      after.some((cells) => cells.has(cellKey(5, 5))),
      "the old document's in-flight answer was committed over the new document",
    ).toBe(false);
    expect(paintedCells().get(cellKey(7, 1))?.display).toBe("NEW");
  });
});
