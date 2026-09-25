// FILENAME: app/extensions/Charts/lib/__tests__/chartsCanvasWiring.test.ts
// PURPOSE: The M4 (canvas sheets) wiring facts in `extensions/Charts/index.ts`.
// CONTEXT: Read as SOURCE, for the reason chartsExtensionWiring.test.ts gives:
//          activating Charts in a unit test is a harness, not a guard, and each
//          fact below is a line whose ABSENCE is silent at runtime -- the
//          behaviour behind each is proved in its own module's tests
//          (dataSourceResolverSheetId, chartInvalidation, chartObjectSelection,
//          chartParamWriteBack, chartStoreSheetIds); this pins that activate()
//          actually uses them.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

function chartsIndexSource(): string {
  return readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
}

/** The body of activate(), so a match elsewhere in the file does not count. */
function activateBody(): string {
  const source = chartsIndexSource();
  const start = source.indexOf("function activate(context: ExtensionContext): void {");
  const end = source.indexOf("function deactivate(): void {");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("activate() wires the canvas-sheet pieces", () => {
  it("installs the sheet-id cache invalidation, with cleanup", () => {
    // Without it the id -> index cache never exists at all (every read asks
    // the backend) -- and if it existed without the listeners, it would go
    // stale on the first sheet move.
    expect(activateBody()).toContain("cleanupFunctions.push(installSheetIdCacheInvalidation());");
  });

  it("registers the chart object-selection provider, with cleanup", () => {
    const body = activateBody();
    const at = body.indexOf("registerObjectSelectionProvider(");
    expect(at, "no object-selection provider is registered").toBeGreaterThan(-1);
    expect(body.slice(at - 40, at)).toContain("cleanupFunctions.push(");
    expect(body.slice(at, at + 200)).toContain("createChartObjectSelectionProvider(");
  });

  it("keys the cell-change invalidation on each chart's SOURCE sheet", () => {
    const body = activateBody();
    const listener = body.slice(body.indexOf("context.events.on(AppEvents.CELLS_UPDATED"));
    const call = listener.slice(0, listener.indexOf("});"));
    expect(call).toContain("peekRangeRefSheetIndex(chart.spec.data)");
    expect(call).toMatch(/chartIntersectsChanges\(chart\.spec, changes, activeSheetIndex, sourceSheetIndex\)/);
  });

  it("reloads the store when the sheet COLLECTION changes (a detail-less SHEET_CHANGED)", () => {
    const body = activateBody();
    const at = body.indexOf("AppEvents.SHEET_CHANGED, async (detail)");
    expect(at, "the SHEET_CHANGED listener does not read its detail").toBeGreaterThan(-1);
    expect(body.slice(at, at + 900)).toContain('if (typeof detail?.sheetIndex !== "number") requestChartsReload("sheets");');
  });

  it("routes charts:refresh and open/new through the one coalesced reload", () => {
    const body = activateBody();
    expect(body).toContain('const handleChartsRefresh = () => requestChartsReload("objects");');
    expect(body).toContain('context.events.on(AppEvents.AFTER_OPEN, () => requestChartsReload("document"))');
    expect(body).toContain('context.events.on(AppEvents.AFTER_NEW, () => requestChartsReload("document"))');
  });
});

describe("param write-back never writes a canvas", () => {
  it("goes through writeParamValueToCell at both sites, and nothing calls updateCell directly", () => {
    const source = chartsIndexSource();
    const sites = source.split("writeParamValueToCell(").length - 1;
    // The brush site and the click site.
    expect(sites).toBe(2);
    expect(source).not.toMatch(/\bupdateCell\(/);
  });
});
