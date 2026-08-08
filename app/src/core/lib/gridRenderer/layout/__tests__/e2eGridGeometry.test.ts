//! FILENAME: app/src/core/lib/gridRenderer/layout/__tests__/e2eGridGeometry.test.ts
// PURPOSE: The shared E2E geometry helper must report the gutters as PAINTED.
// CONTEXT: `app/e2e/helpers/grid.ts` translates a cell reference into canvas
//          pixels for every click and every screenshot probe in the suite. It
//          took `config.rowHeaderWidth` at its word -- and the config keeps
//          reporting 22/20 when the headings are hidden, while the renderer
//          paints 0/0. Every coordinate it produced on a headings-off canvas was
//          then 22px left and 20px above the truth: clicks landed in the
//          neighbouring cell and canvas probes sampled the wrong patch, silently
//          (a perfectly painted shape scored 0.80).
//
//          The helper lives outside `src/`, so vitest does not collect it (see
//          vite.config.ts `include`). It is exercised HERE, driving the real
//          function with a fake Playwright `Page` whose `evaluate` runs the
//          callback against a jsdom window -- which is exactly the contract that
//          matters, since the callback is what runs inside the app.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readGridGeometry, cellRangeRectFrom } from "../../../../../../e2e/helpers/grid";
import { DEFAULT_GRID_CONFIG } from "../../../../types";

/** Enough of a Playwright Page for `readGridGeometry`. */
function fakePage(): { evaluate: (fn: (arg?: unknown) => unknown) => Promise<unknown> } {
  return { evaluate: (fn) => Promise.resolve(fn()) };
}

const HEADER_MODULE = "/src/core/lib/gridRenderer/layout/headerVisibility.ts";

function installGridState(displayHeadings: boolean): void {
  (window as unknown as Record<string, unknown>).__CALCULA_GRID_STATE__ = {
    config: { ...DEFAULT_GRID_CONFIG },
    dimensions: { columnWidths: new Map(), rowHeights: new Map(), hiddenCols: new Set(), hiddenRows: new Set() },
    viewport: { scrollX: 0, scrollY: 0 },
    zoom: 1,
    displayHeadings,
  };
}

beforeEach(() => {
  // The app installs this in main.tsx under import.meta.env.DEV; the helper
  // REFUSES to guess without it, which is the behaviour asserted below.
  (window as unknown as Record<string, unknown>).__calcImport = async (url: string) => {
    if (url.endsWith(HEADER_MODULE)) return import("../headerVisibility");
    throw new Error(`unexpected module ${url}`);
  };
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__calcImport;
  delete (window as unknown as Record<string, unknown>).__CALCULA_GRID_STATE__;
});

describe("readGridGeometry reports the gutters as PAINTED", () => {
  it("headings SHOWN: the configured sizes", async () => {
    installGridState(true);
    const geo = await readGridGeometry(fakePage() as never);
    expect(geo.rowHeaderWidth).toBe(DEFAULT_GRID_CONFIG.rowHeaderWidth);
    expect(geo.colHeaderHeight).toBe(DEFAULT_GRID_CONFIG.colHeaderHeight);
  });

  it("headings HIDDEN: zero, not the 22/20 the config still reports", async () => {
    installGridState(false);
    const geo = await readGridGeometry(fakePage() as never);
    expect(geo.rowHeaderWidth).toBe(0);
    expect(geo.colHeaderHeight).toBe(0);
    // Teeth: the config it read from has NOT changed, so a helper that trusted
    // it would have returned 22/20 here.
    const gs = (window as unknown as Record<string, any>).__CALCULA_GRID_STATE__;
    expect(gs.config.rowHeaderWidth).toBe(DEFAULT_GRID_CONFIG.rowHeaderWidth);
  });

  it("a cell rectangle moves by exactly one header size between the two states", async () => {
    installGridState(true);
    const shown = cellRangeRectFrom("B2", "B2", await readGridGeometry(fakePage() as never));
    installGridState(false);
    const hidden = cellRangeRectFrom("B2", "B2", await readGridGeometry(fakePage() as never));

    expect(shown.x - hidden.x).toBe(DEFAULT_GRID_CONFIG.rowHeaderWidth);
    expect(shown.y - hidden.y).toBe(DEFAULT_GRID_CONFIG.colHeaderHeight);
    // The cell's SIZE is a property of the grid, not of the headings.
    expect(hidden.width).toBe(shown.width);
    expect(hidden.height).toBe(shown.height);
  });

  it("REFUSES rather than guesses when the rule cannot be imported", async () => {
    installGridState(false);
    delete (window as unknown as Record<string, unknown>).__calcImport;
    await expect(readGridGeometry(fakePage() as never)).rejects.toThrow(/__calcImport/);
  });

  it("still yields the launch fallbacks when the app has not booted", async () => {
    delete (window as unknown as Record<string, unknown>).__CALCULA_GRID_STATE__;
    const geo = await readGridGeometry(fakePage() as never);
    expect(geo.rowHeaderWidth).toBe(22);
    expect(geo.colHeaderHeight).toBe(20);
  });
});
