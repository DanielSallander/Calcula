// FILENAME: app/extensions/Charts/lib/__tests__/chartsExtensionWiring.test.ts
// PURPOSE: Two wiring facts in `extensions/Charts/index.ts` that are invisible
//          to every behavioural test in this repo, because the defect in each
//          case is something that is NOT there.
// CONTEXT: Read as SOURCE, deliberately. `index.ts` is the extension's
//          activate() — importing it pulls in the store, the renderer, the
//          overlay host, the backend facade and a dozen @api seams, so a unit
//          test that "activates Charts" would be a harness, not a guard. Both
//          facts below are one-liners whose absence is silent at runtime, and
//          both were absent.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

function chartsIndexSource(): string {
  return readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
}

describe("a chart edit made inside the debounce window reaches the file", () => {
  it("flushes the pending chart saves on BEFORE_SAVE", () => {
    // `chartStore` batches persistence 300 ms deep. A title commit, a drag or a
    // resize finished just before Ctrl+S was still a pending setTimeout when
    // `save_file` serialised AppState, so the file got the OLD chart — and on
    // close it was worse than stale: the dirty flag is set by
    // `DocumentEffect::mutates` INSIDE `update_chart`, so an edit that never
    // flushed left `is_modified` false and the close-without-saving prompt
    // never appeared. `flushPendingChartSaves` documented itself as "call this
    // before file save or app close" and had NO caller in the product at all.
    const source = chartsIndexSource();
    expect(source).toContain("flushPendingChartSaves");

    const at = source.indexOf("AppEvents.BEFORE_SAVE, AppEvents.BEFORE_CLOSE");
    expect(at, "Charts registers no BEFORE_SAVE / BEFORE_CLOSE listener").toBeGreaterThan(-1);
    // The listener body, not merely the names somewhere in the file.
    expect(source.slice(at, at + 200)).toContain("flushPendingChartSaves()");
  });
});

describe("one selection fact cannot be announced twice, out of order", () => {
  it("guards the async CHART_SELECTION_CHANGED emit with a generation token", () => {
    // `emitChartSelectionEvent` is synchronous for chart/axis/element levels and
    // ASYNCHRONOUS for series/dataPoint (it resolves the sheet name and builds
    // the SERIES formula). Every call site is fire-and-forget, so a selection
    // made while an earlier series-level emit was awaiting was announced FIRST
    // and the stale series payload LAST: the formula bar armed series-reference
    // drag/resize for a series that was no longer selected, while the Name Box
    // — reading the synchronous @api registry — correctly said "Chart Area".
    const source = chartsIndexSource();

    const fn = source.slice(
      source.indexOf("async function emitChartSelectionEvent"),
      source.indexOf("// Chart deletion"),
    );
    expect(fn.length).toBeGreaterThan(400);

    // Taken at ENTRY...
    const taken = fn.indexOf("const generation = ++chartSelectionEmitGeneration;");
    expect(taken, "the emit takes no generation token").toBeGreaterThan(-1);

    // ...and re-checked before the payload that had to wait is announced.
    const check = fn.indexOf("if (generation !== chartSelectionEmitGeneration) return;");
    const emit = fn.lastIndexOf("emitAppEvent(AppEvents.CHART_SELECTION_CHANGED, payload)");
    expect(check, "a superseded emit is never dropped").toBeGreaterThan(taken);
    expect(check).toBeLessThan(emit);

    // The awaits it is protecting against are real and still there.
    expect(fn).toContain("await getSheets()");
    expect(fn).toContain("await buildSeriesFormula(");
  });
});

describe("the chart context menu does not steal a right-click that is not the chart's", () => {
  /** `handleContextMenu`, read out of index.ts at test time. */
  function contextMenuSource(): string {
    const source = chartsIndexSource();
    const start = source.indexOf("const handleContextMenu = (e: MouseEvent) => {");
    const end = source.indexOf('window.addEventListener("contextmenu", handleContextMenu, true);', start);
    expect(start, "handleContextMenu was not found — this guard reads nothing").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("refuses a right-click whose target is a text surface, BEFORE resolving a chart", () => {
    // The chart is resolved by GEOMETRY alone, so the <textarea> the overlay
    // text editor mounts over a chart title was inside the chart's rect: the
    // editor's own paste menu was suppressed (preventDefault) and the Chart
    // menu opened on top of the field the reader was typing in. The pointer
    // CLAIM cannot answer this — `isPointerClaimed` never claims the secondary
    // button by design — which is why the guard is the target class, exactly as
    // Core's sibling door for the same editor (`handleOverlayDoubleClick`) has
    // it.
    const body = contextMenuSource();
    const guard = body.indexOf('target.tagName === "TEXTAREA"');
    expect(guard, "the chart menu claims a right-click on a text field").toBeGreaterThan(-1);
    expect(body.indexOf('target.tagName === "INPUT"')).toBeGreaterThan(-1);
    expect(body.indexOf("target.isContentEditable")).toBeGreaterThan(-1);
    // Before the chart is resolved, and before anything is consumed.
    expect(guard).toBeLessThan(body.indexOf("findChartAtCanvasPos("));
    expect(guard).toBeLessThan(body.indexOf("e.preventDefault()"));
  });

  it("refuses a right-click outside the grid container's own box", () => {
    // A chart REGION is not clipped to the visible canvas. Open the Chart
    // Format task pane — which narrows the grid — and a chart wider than the
    // grid matches a point inside the pane, so the pane's own right-click was
    // swallowed and the chart menu opened over it. The hover fallback must not
    // rescue it either: hover is rAF-throttled and holds whatever the pointer
    // was last over INSIDE the grid.
    const body = contextMenuSource();
    const clip = body.indexOf("e.clientX < rect.left");
    expect(clip, "the chart menu is not clipped to the grid").toBeGreaterThan(-1);
    expect(body.slice(clip)).toContain("e.clientY > rect.bottom");
    expect(clip).toBeLessThan(body.indexOf("findChartAtCanvasPos("));
    expect(clip).toBeLessThan(body.indexOf("hover?.chartId"));
  });
});
