//! FILENAME: app/e2e/soak/synthetic-click-drag.spec.ts
// PURPOSE: A zero-duration click must not leave the grid dragging.
//
// THE DEFECT (BUG-0038). `handleGlobalMouseUp` in `useMouseSelection` is always
// attached, but it reads the drag flags from the CLOSURE of the render it was
// attached in. A mousedown starts a drag with `setIsDragging(true)`; if the
// matching mouseup is dispatched before React has committed that state, the
// still-attached handler sees every flag `false` and ends nothing. The flag
// stays `true` for good, and the conditional `mousemove` listener — which IS
// attached on the next render — then extends the selection on every subsequent
// pointer MOVE, with no button held.
//
// MEASURED on the running app, clicking one cell and then only moving the mouse:
//
//   hold  0ms -> the selection follows the pointer forever   (STUCK)
//   hold  5ms -> correct
//   hold 20ms and up -> correct
//
// A physical mouse never produces a 0 ms click, which is why no human ever
// reported it. `element.click()` always does. For a product whose premise is
// user automation — macro replay, object scripts, MCP-driven interaction, and
// OS-synthesized touch/pen taps — "the grid enters an unending drag when a
// script clicks a cell" is a real defect.
//
// It reached the surface as a MALFORMED selection: on invariant seed 90040001
// the `selection-in-bounds` invariant caught {startRow:14 ... endRow:3}, an
// inverted range. The 3-action repro was chart.create -> click B15 -> click G4,
// where G4 sits under the chart: the chart overlay consumes the second
// mousedown, so nothing re-anchors the phantom drag and the malformed range
// survives long enough to be observed. Anything iterating startRow..endRow
// over that selection silently operates on nothing.
//
// This spec pins all three halves: the stuck drag, that a REAL drag still
// works, and that clicking a chart no longer disturbs the cell selection
// (Excel leaves it alone).
//
// It lives in the `soak` project rather than `e2e/tests` because it
// deep-resets the workbook several times, which would shift the functional
// suite's shared screenshot baselines — the same reason `state-consistency`
// has its own project.

import { test, expect } from "../fixtures";
import { FULL_ACTION_CATALOG, deepResetForWalk, findAction } from "../walker";
import type { Page } from "@playwright/test";

const act = (id: string) => findAction(id, FULL_ACTION_CATALOG)!;

interface Sel {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

async function selection(page: Page): Promise<Sel | null> {
  return page.evaluate(() => {
    const gs = (window as any).__CALCULA_GRID_STATE__;
    const s = typeof gs === "function" ? gs() : gs;
    return s?.selection ?? null;
  });
}

const same = (a: Sel | null, b: Sel | null) => JSON.stringify(a) === JSON.stringify(b);

test.describe("a synthetic (zero-duration) click must not leave the grid dragging", () => {
  test.setTimeout(300_000);

  test("hovering after a 0ms click does not move the selection", async ({
    appPage,
    grid,
  }) => {
    const box = (await grid.canvas.boundingBox())!;
    const cellA = { x: box.x + 60, y: box.y + 310 };
    const cellB = { x: box.x + 440, y: box.y + 90 };

    // Three times: this was intermittent before the fix only because a stale
    // latch from the previous gesture sometimes masked it.
    for (let attempt = 0; attempt < 3; attempt++) {
      await deepResetForWalk(appPage);
      await appPage.waitForTimeout(400);

      await appPage.mouse.move(cellA.x, cellA.y);
      await appPage.mouse.down();
      await appPage.mouse.up(); // zero hold — what element.click() produces
      await appPage.waitForTimeout(300);

      const afterClick = await selection(appPage);
      expect(afterClick, "the click selected nothing").not.toBeNull();

      await appPage.mouse.move(cellB.x, cellB.y);
      await appPage.waitForTimeout(250);
      const afterHover = await selection(appPage);

      expect(
        same(afterClick, afterHover),
        `attempt ${attempt}: moving the mouse with no button held changed the ` +
          `selection from ${JSON.stringify(afterClick)} to ` +
          `${JSON.stringify(afterHover)} — the grid is still dragging`
      ).toBe(true);
    }
  });

  test("a real press-move-release still selects a range, and stops there", async ({
    appPage,
    grid,
  }) => {
    // The fix must not cost the feature it protects. Without this case,
    // "end every drag immediately" would pass the test above.
    const box = (await grid.canvas.boundingBox())!;
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);

    await appPage.mouse.move(box.x + 60, box.y + 310);
    await appPage.mouse.down();
    await appPage.waitForTimeout(60);
    await appPage.mouse.move(box.x + 440, box.y + 90, { steps: 6 });
    await appPage.waitForTimeout(60);
    await appPage.mouse.up();
    await appPage.waitForTimeout(300);

    const dragged = await selection(appPage);
    expect(dragged, "the drag selected nothing").not.toBeNull();
    expect(
      dragged!.startRow !== dragged!.endRow || dragged!.startCol !== dragged!.endCol,
      `a press-move-release selected a single cell (${JSON.stringify(dragged)}) — ` +
        `the drag was ended too eagerly`
    ).toBe(true);

    await appPage.mouse.move(box.x + 120, box.y + 120);
    await appPage.waitForTimeout(250);
    expect(
      same(dragged, await selection(appPage)),
      "the selection kept growing after the button was released"
    ).toBe(true);
  });

  test("the selection is never inverted, and a chart click leaves it alone", async ({
    appPage,
    grid,
  }) => {
    // The exact 3-action trace the invariant walker minimized, as a named test.
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);
    await act("chart.create").execute(appPage, grid, { title: "SyntheticClick_1" });
    await appPage.waitForTimeout(400);

    await act("cell.click").execute(appPage, grid, { ref: "B15" });
    const beforeChartClick = await selection(appPage);
    expect(beforeChartClick).toEqual({
      startRow: 14,
      startCol: 1,
      endRow: 14,
      endCol: 1,
      type: "cells",
    });

    // G4 sits under the chart placed at (400,40) 480x300.
    await act("cell.click").execute(appPage, grid, { ref: "G4" });
    await appPage.waitForTimeout(300);
    const after = (await selection(appPage))!;

    expect(
      after.endRow >= after.startRow && after.endCol >= after.startCol,
      `the selection model is holding an inverted range: ${JSON.stringify(after)}`
    ).toBe(true);
    // Excel: clicking a chart does not change which cells are selected.
    expect(
      same(beforeChartClick, after),
      `clicking a chart changed the cell selection from ` +
        `${JSON.stringify(beforeChartClick)} to ${JSON.stringify(after)}`
    ).toBe(true);

    await deepResetForWalk(appPage);
  });
});
