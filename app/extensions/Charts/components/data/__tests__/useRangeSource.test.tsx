//! FILENAME: app/extensions/Charts/components/data/__tests__/useRangeSource.test.tsx
// PURPOSE: THE range-source rules (WP-C S9c), shared by the chart dialog and
//          the object pane's range Data tab: one cell is one value (no header
//          row, the cell is the series), the header row a single cell switched
//          off comes back for a table, a sheet-qualified range binds on a
//          canvas while an unprefixed one is refused, a defined name resolves
//          (and a name over a canvas is refused), and the hook without
//          `detection` never auto-detects (the pane decides at commit time).
// CONTEXT: The dialog's own cases stay in components/__tests__ (they drive the
//          dialog end to end); these pin the rules at the hook and at the pure
//          functions both callers reach.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  autoDetectSeries: vi.fn(async (..._args: unknown[]) => ({
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    orientation: "columns",
  })),
  resolveDataSource: vi.fn(),
}));

vi.mock("@api", () => ({
  indexToCol: (i: number) => String.fromCharCode(65 + i),
}));
vi.mock("../../../lib/chartDataReader", () => ({
  autoDetectSeries: (...args: unknown[]) => h.autoDetectSeries(...args),
}));
vi.mock("../../../lib/dataSourceResolver", () => ({
  resolveDataSource: (...args: unknown[]) => h.resolveDataSource(...args),
}));

import {
  detectRangeShape,
  planRangeShape,
  rangeAxes,
  resolveRangeName,
  useRangeSource,
  type RangeSourceState,
  type UseRangeSourceOptions,
} from "../useRangeSource";
import { CANVAS_NEEDS_SHEET_MESSAGE } from "../../../lib/chartRangeBinding";
import type { ChartSeries, SeriesOrientation } from "../../../types";
import type { SheetInfo } from "@api/lib";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SHEETS: SheetInfo[] = [
  { index: 0, name: "Sheet1", sheetId: "id-0", visibility: "visible" } as SheetInfo,
  { index: 1, name: "Sheet2", sheetId: "id-1", visibility: "visible" } as SheetInfo,
  { index: 2, name: "Page", sheetId: "id-2", visibility: "visible", kind: "canvas" } as SheetInfo,
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.autoDetectSeries.mockClear();
  h.resolveDataSource.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** A dialog-like harness: owns the series state and hands the hook its setters. */
interface Harness {
  state: RangeSourceState | null;
  hasHeaders: boolean;
  categoryIndex: number;
  series: ChartSeries[];
  unbound: number;
  setRange(text: string): void;
}

function mountHarness(opts: Partial<UseRangeSourceOptions> & { detect: boolean; initialRange?: string }): Harness {
  const out: Harness = {
    state: null,
    hasHeaders: true,
    categoryIndex: -1,
    series: [],
    unbound: 0,
    setRange: () => {},
  };
  function Probe(): null {
    const [range, setRange] = React.useState(opts.initialRange ?? "");
    const [hasHeaders, setHasHeaders] = React.useState(true);
    const [categoryIndex, setCategoryIndex] = React.useState(-1);
    const [series, setSeries] = React.useState<ChartSeries[]>([]);
    const orientation: SeriesOrientation = opts.orientation ?? "columns";
    out.state = useRangeSource({
      sourceRange: range,
      sheets: opts.sheets ?? SHEETS,
      currentSheetIndex: opts.currentSheetIndex ?? 0,
      currentSheetName: opts.currentSheetName ?? "Sheet1",
      currentIsCanvas: opts.currentIsCanvas ?? false,
      rangeMode: opts.rangeMode ?? true,
      orientation,
      detection: opts.detect
        ? {
            hasHeaders,
            setHasHeaders,
            setCategoryIndex,
            setSeries,
            onUnbound: () => {
              out.unbound += 1;
            },
          }
        : null,
    });
    out.hasHeaders = hasHeaders;
    out.categoryIndex = categoryIndex;
    out.series = series;
    out.setRange = setRange;
    return null;
  }
  act(() => root.render(<Probe />));
  return out;
}

describe("pure rules", () => {
  it("rangeAxes: one axis per column, or one per row", () => {
    const ref = { sheetIndex: 0, startRow: 4, startCol: 1, endRow: 6, endCol: 3 };
    expect(rangeAxes(ref, "columns")).toEqual([
      { index: 0, label: "B" },
      { index: 1, label: "C" },
      { index: 2, label: "D" },
    ]);
    expect(rangeAxes(ref, "rows")).toEqual([
      { index: 0, label: "Row 5" },
      { index: 1, label: "Row 6" },
      { index: 2, label: "Row 7" },
    ]);
  });

  it("planRangeShape: one cell is one value named by its address (or its name)", () => {
    const cell = { sheetIndex: 0, startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
    expect(planRangeShape(cell, { hasHeaders: true, headersForcedOff: false, name: null })).toEqual({
      kind: "single",
      series: [{ name: "B2", sourceIndex: 0, color: null }],
      turnHeadersOff: true,
    });
    expect(planRangeShape(cell, { hasHeaders: false, headersForcedOff: false, name: "TotalSales" })).toMatchObject({
      kind: "single",
      series: [{ name: "TotalSales" }],
      turnHeadersOff: false,
    });
  });

  it("planRangeShape: a table after a single cell restores the header row only when the cell switched it off", () => {
    const table = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 };
    expect(planRangeShape(table, { hasHeaders: false, headersForcedOff: true, name: null })).toEqual({ kind: "restoreHeaders" });
    // The reader switched it off: it stays off.
    expect(planRangeShape(table, { hasHeaders: false, headersForcedOff: false, name: null })).toEqual({
      kind: "detect",
      clearForced: false,
    });
  });

  it("detectRangeShape runs the plan to its end (restore, then detect with the header row)", async () => {
    const table = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 };
    const shape = await detectRangeShape(table, { hasHeaders: false, headersForcedOff: true, name: null });
    expect(shape).toEqual({
      hasHeaders: true,
      categoryIndex: 0,
      series: [{ name: "Sales", sourceIndex: 1, color: null }],
      headersForcedOff: false,
    });
    expect(h.autoDetectSeries).toHaveBeenCalledWith(table, true);
  });

  it("detectRangeShape never detects over one cell", async () => {
    const cell = { sheetIndex: 0, startRow: 2, startCol: 0, endRow: 2, endCol: 0 };
    const shape = await detectRangeShape(cell, { hasHeaders: true, headersForcedOff: false, name: null });
    expect(shape).toEqual({
      hasHeaders: false,
      categoryIndex: 0,
      series: [{ name: "A3", sourceIndex: 0, color: null }],
      headersForcedOff: true,
    });
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });

  it("resolveRangeName: stamps the sheet id; refuses a canvas and an unknown name", async () => {
    h.resolveDataSource.mockResolvedValueOnce({ sheetIndex: 1, startRow: 0, startCol: 0, endRow: 3, endCol: 1 });
    expect(await resolveRangeName("Sales", SHEETS)).toEqual({
      name: "Sales",
      ref: { sheetIndex: 1, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
      error: null,
    });
    h.resolveDataSource.mockResolvedValueOnce({ sheetIndex: 2, startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    const canvas = await resolveRangeName("OnPage", SHEETS);
    expect(canvas.ref).toBeNull();
    expect(canvas.error).toMatch(/canvas/i);
    h.resolveDataSource.mockRejectedValueOnce(new Error("no such name"));
    const unknown = await resolveRangeName("Nope", SHEETS);
    expect(unknown.ref).toBeNull();
    expect(unknown.error).toContain('"Nope" is not a range or a defined name');
  });
});

describe("the hook (the dialog's wiring: detection on)", () => {
  it("one cell: header row forced off, category 0, the cell is the series, nothing detected", async () => {
    const hx = mountHarness({ detect: true });
    act(() => hx.setRange("Sheet1!B2"));
    await flush();
    expect(hx.state!.isSingleCell).toBe(true);
    expect(hx.state!.rangeError).toBeNull();
    expect(hx.hasHeaders).toBe(false);
    expect(hx.categoryIndex).toBe(0);
    expect(hx.series).toEqual([{ name: "B2", sourceIndex: 0, color: null }]);
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
  });

  it("back from one cell to a table: the header row is on again and the series are detected with it", async () => {
    const hx = mountHarness({ detect: true });
    act(() => hx.setRange("Sheet1!B2"));
    await flush();
    act(() => hx.setRange("Sheet1!A1:B5"));
    await flush();
    expect(hx.hasHeaders).toBe(true);
    expect(hx.series).toEqual([{ name: "Sales", sourceIndex: 1, color: null }]);
    expect(h.autoDetectSeries).toHaveBeenLastCalledWith(
      { sheetIndex: 0, sheetId: "id-0", startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
      true,
    );
  });

  it("an unbound range drops the series and tells the caller", async () => {
    const hx = mountHarness({ detect: true, initialRange: "Sheet1!A1:B5" });
    await flush();
    const before = hx.unbound;
    act(() => hx.setRange("not a range!!"));
    await flush();
    expect(hx.series).toEqual([]);
    expect(hx.unbound).toBe(before + 1);
    expect(hx.state!.rangeError).not.toBeNull();
  });
});

describe("the hook on a canvas page", () => {
  it("a sheet-qualified range binds to THAT sheet (index and id)", async () => {
    const hx = mountHarness({ detect: false, currentSheetIndex: 2, currentSheetName: "Page", currentIsCanvas: true });
    act(() => hx.setRange("Sheet2!A1:C5"));
    await flush();
    expect(hx.state!.rangeError).toBeNull();
    expect(hx.state!.boundRef).toEqual({ sheetIndex: 1, sheetId: "id-1", startRow: 0, startCol: 0, endRow: 4, endCol: 2 });
    expect(hx.state!.availableAxes.map((a) => a.label)).toEqual(["A", "B", "C"]);
  });

  it("an unprefixed range is refused: a canvas has no cells", async () => {
    const hx = mountHarness({ detect: false, currentSheetIndex: 2, currentSheetName: "Page", currentIsCanvas: true });
    act(() => hx.setRange("A1:C5"));
    await flush();
    expect(hx.state!.boundRef).toBeNull();
    expect(hx.state!.rangeError).toBe(CANVAS_NEEDS_SHEET_MESSAGE);
  });

  it("without detection the hook never auto-detects (the pane decides when it commits)", async () => {
    const hx = mountHarness({ detect: false, currentSheetIndex: 2, currentSheetName: "Page", currentIsCanvas: true });
    act(() => hx.setRange("Sheet1!A1:C5"));
    await flush();
    act(() => hx.setRange("Sheet1!B2"));
    await flush();
    expect(h.autoDetectSeries).not.toHaveBeenCalled();
    expect(hx.series).toEqual([]);
  });

  it("a defined name resolves to its cells; a name over a canvas is refused", async () => {
    h.resolveDataSource.mockResolvedValue({ sheetIndex: 0, startRow: 4, startCol: 2, endRow: 4, endCol: 2 });
    const hx = mountHarness({ detect: false, currentSheetIndex: 2, currentSheetName: "Page", currentIsCanvas: true });
    act(() => hx.setRange("TotalSales"));
    await flush();
    expect(hx.state!.nameCandidate).toBe("TotalSales");
    expect(hx.state!.boundRef).toEqual({ sheetIndex: 0, sheetId: "id-0", startRow: 4, startCol: 2, endRow: 4, endCol: 2 });
    expect(hx.state!.isSingleCell).toBe(true);

    h.resolveDataSource.mockResolvedValue({ sheetIndex: 2, startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    act(() => hx.setRange("OnThePage"));
    await flush();
    expect(hx.state!.boundRef).toBeNull();
    expect(hx.state!.rangeError).toMatch(/canvas/i);
  });

  it("a non-range source (pivot / design query) looks up no name and reports no range error", async () => {
    const hx = mountHarness({ detect: false, rangeMode: false });
    act(() => hx.setRange("TotalSales"));
    await flush();
    expect(hx.state!.nameCandidate).toBeNull();
    expect(hx.state!.rangeError).toBeNull();
    expect(h.resolveDataSource).not.toHaveBeenCalled();
  });
});
