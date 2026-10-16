//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotLayoutEdits.test.ts
// PURPOSE: A pivot's report LAYOUT changed WITHOUT a mounted field-list editor
//          (WP-C S10: the canvas box's Format tab Layout card opened straight
//          from Ctrl+1; the Design ribbon while the field list is closed --
//          which used to do NOTHING, because only a mounted editor answered
//          PIVOT_LAYOUT_CHANGED):
//          - the pivot's whole fields request goes back with ONLY the layout
//            changed (the definition's layout + the patch), no item filter
//            echoed, the style never riding along;
//          - the new layout is announced (the sections show it) and the pivot
//            repaints; a pivot that cannot be read is a sentence, never a send.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  bi: [] as unknown[],
  range: [] as unknown[],
  regions: [] as Array<{ pivotId: string; startRow: number; startCol: number }>,
  info: null as unknown,
  announced: [] as Array<[string, unknown]>,
}));

vi.mock("@api/pivot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/pivot")>()),
  pivot: {
    updateBiFields: vi.fn((req: unknown) => {
      h.bi.push(req);
      return Promise.resolve({});
    }),
    updateFields: vi.fn((req: unknown) => {
      h.range.push(req);
      return Promise.resolve({});
    }),
    getAtCell: vi.fn(() => Promise.resolve(null)),
  },
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  emitAppEvent: (event: string, detail: unknown) => {
    h.announced.push([event, detail]);
  },
}));
vi.mock("../pivot-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pivot-api")>()),
  getPivotAtCell: vi.fn(() => Promise.resolve(h.info)),
}));
vi.mock("../../handlers/selectionHandler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../handlers/selectionHandler")>()),
  getCachedRegions: () => h.regions,
}));

import { editPivotLayoutHeadless, readPivotLayout } from "../pivotLayoutEdits";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";
import { rangeInfo, biInfo } from "./fixtures/pivotFieldsFixtures";
import type { PivotRegionInfo } from "@api/pivot";
import type { UpdatePivotFieldsRequest } from "../../components/types";

function install(info: PivotRegionInfo): void {
  h.info = info;
  h.regions = [{ pivotId: String(info.pivotId), startRow: 4, startCol: 1 }];
}

let refreshes = 0;
beforeEach(() => {
  h.bi = [];
  h.range = [];
  h.info = null;
  h.regions = [];
  h.announced = [];
  refreshes = 0;
  window.addEventListener("pivot:refresh", () => refreshes++);
});

describe("editPivotLayoutHeadless", () => {
  it("range pivot: ONE fields update with the definition's layout + the patch; zones as they are, no item filter echoed", async () => {
    install(rangeInfo());
    const before = await readPivotLayout("7");
    await editPivotLayoutHeadless("7", { showRowGrandTotals: false, styleId: "PivotStyleDark1" });
    expect(h.range).toHaveLength(1);
    const req = h.range[0] as UpdatePivotFieldsRequest;
    expect(req.layout).toEqual({ ...before, showRowGrandTotals: false });
    expect(req.layout).not.toHaveProperty("styleId");
    expect(req.rowFields).toEqual([{ sourceIndex: 0, name: "Region" }]);
    expect(req.valueFields.map((v) => v.name)).toEqual(
      (rangeInfo().fieldConfiguration.valueFields as Array<{ name: string }>).map((v) => v.name),
    );
  });

  it("announces the new layout (the sections show it) and repaints", async () => {
    install(rangeInfo());
    const layout = await editPivotLayoutHeadless("7", { reportLayout: "tabular" });
    expect(h.announced).toContainEqual([PivotEvents.PIVOT_LAYOUT_STATE, { pivotId: "7", layout }]);
    expect(layout.reportLayout).toBe("tabular");
    expect(refreshes).toBeGreaterThan(0);
  });

  it("data-model pivot: through updateBiFields, the layout patched", async () => {
    install(biInfo());
    await editPivotLayoutHeadless("9", { showColumnGrandTotals: false });
    expect(h.range).toEqual([]);
    expect(h.bi).toHaveLength(1);
    expect((h.bi[0] as { layout: Record<string, unknown> }).layout).toMatchObject({
      showColumnGrandTotals: false,
      showRowGrandTotals: true,
      reportLayout: "compact",
    });
  });

  it("a pivot not on the sheet, or answering as another, is a sentence and sends nothing", async () => {
    await expect(editPivotLayoutHeadless("7", { showRowGrandTotals: false })).rejects.toThrow("not on this sheet");
    install({ ...rangeInfo(), pivotId: "8" } as PivotRegionInfo);
    h.regions = [{ pivotId: "7", startRow: 0, startCol: 0 }];
    await expect(editPivotLayoutHeadless("7", { showRowGrandTotals: false })).rejects.toThrow("could not be read");
    expect(await readPivotLayout("7")).toBeNull();
    expect(h.range).toEqual([]);
    expect(h.bi).toEqual([]);
  });
});
