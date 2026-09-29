//! FILENAME: app/extensions/Charts/lib/__tests__/dataSourceResolverSheetId.test.ts
// PURPOSE: M4 (canvas sheets) -- a DataRangeRef resolves its sheet ID-FIRST.
//          A chart on a canvas reads its data from another sheet, and the only
//          thing that keeps naming that sheet across an insert / delete / move
//          is its stable id. Pinned here:
//            - an id maps to the LIVE index (a moved sheet is followed);
//            - an id that names no sheet is an ERROR, never a fall back to the
//              stored index (which may well name some other, existing sheet);
//            - no id -> the stored index, with no sheet-list read at all;
//            - the id -> index map is ONE cached getSheets() while the
//              invalidation is installed, and every sheet-collection event
//              drops it (SHEET_CHANGED / ADDED / DELETED / RENAMED, AFTER_OPEN,
//              AFTER_NEW);
//            - the synchronous peek the invalidation listener uses;
//            - a sheet-qualified A1 string still resolves by NAME, an
//              unqualified one to the ACTIVE sheet.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  getNamedRange: vi.fn(),
  getRangeCellsTyped: vi.fn(),
  gridState: null as null | { sheetContext: { activeSheetIndex: number; activeSheetName: string } },
}));

// Only the doors the resolver and the sheet map use. The whole `@api` facade is
// NOT imported: its module-level hooks would react to the AFTER_OPEN this file
// emits.
vi.mock("@api/lib", () => ({
  getSheets: h.getSheets,
  getRangeCellsTyped: h.getRangeCellsTyped,
}));
vi.mock("@api", () => ({
  getSheets: h.getSheets,
  getNamedRange: h.getNamedRange,
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => h.gridState,
}));

import {
  resolveDataSource,
  resolveRangeRefSheet,
  peekRangeRefSheetIndex,
  SourceSheetMissingError,
  SOURCE_SHEET_MISSING_MESSAGE,
} from "../dataSourceResolver";
import {
  installSheetIdCacheInvalidation,
  loadSheetIdMap,
  resetSheetIdCacheForTests,
  sheetIdCacheInvalidatingEvents,
} from "../sheetIdMap";
import { emitAppEvent, AppEvents } from "@api/events";
import type { ChartSpec, DataRangeRef } from "../../types";
import { stampSpecSheetIds } from "../chartSheetRefs";
import * as fs from "fs";
import * as path from "path";

type Sheet = { index: number; name: string; sheetId?: string; kind?: "worksheet" | "canvas"; visibility: "visible" };
const sheet = (index: number, name: string, sheetId?: string, kind?: "worksheet" | "canvas"): Sheet => ({
  index,
  name,
  visibility: "visible",
  ...(sheetId ? { sheetId } : {}),
  ...(kind ? { kind } : {}),
});

/** Sheet1 (id A), Sheet2 (id B), Canvas (id C). */
const THREE = [sheet(0, "Sheet1", "id-A"), sheet(1, "Sheet2", "id-B"), sheet(2, "Page", "id-C", "canvas")];

function listIs(sheets: Sheet[]): void {
  h.getSheets.mockImplementation(async () => ({ sheets, activeIndex: 0 }));
}

const ref = (over: Partial<DataRangeRef> = {}): DataRangeRef => ({
  sheetIndex: 0,
  startRow: 0,
  startCol: 0,
  endRow: 4,
  endCol: 1,
  ...over,
});

/** Let background re-warms and promise chains settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

let uninstall: (() => void) | null = null;

beforeEach(() => {
  resetSheetIdCacheForTests();
  h.getSheets.mockReset();
  h.getNamedRange.mockReset();
  h.getRangeCellsTyped.mockReset();
  h.gridState = null;
  listIs(THREE);
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetSheetIdCacheForTests();
});

describe("resolveRangeRefSheet: the sheet id wins", () => {
  it("maps the id to the LIVE index (a moved sheet is followed, the stale index ignored)", async () => {
    // Sheet2 (id-B) was moved to the front: it is index 0 now.
    listIs([sheet(0, "Sheet2", "id-B"), sheet(1, "Sheet1", "id-A")]);
    const out = await resolveRangeRefSheet(ref({ sheetIndex: 1, sheetId: "id-B" }));
    expect(out.sheetIndex).toBe(0);
    expect(out.sheetId).toBe("id-B");
    expect(out.startRow).toBe(0);
    expect(out.endCol).toBe(1);
  });

  it("throws 'source sheet no longer exists' for a deleted sheet -- never falls back to the index", async () => {
    // The stored index (0) still names a sheet -- Sheet1 -- which is exactly
    // the sheet a fall back would silently chart instead.
    listIs([sheet(0, "Sheet1", "id-A")]);
    const p = resolveRangeRefSheet(ref({ sheetIndex: 0, sheetId: "id-GONE" }));
    await expect(p).rejects.toBeInstanceOf(SourceSheetMissingError);
    await expect(resolveRangeRefSheet(ref({ sheetIndex: 0, sheetId: "id-GONE" }))).rejects.toThrow(
      /source sheet no longer exists/,
    );
  });

  it("uses the stored index when the ref has no id, without reading the sheet list", async () => {
    const r = ref({ sheetIndex: 1 });
    expect(await resolveRangeRefSheet(r)).toBe(r);
    expect(h.getSheets).not.toHaveBeenCalled();
  });

  it("resolveDataSource goes through the same id-first rule for a DataRangeRef", async () => {
    listIs([sheet(0, "X", "id-X"), sheet(1, "Y", "id-Y"), sheet(2, "Sheet1", "id-A")]);
    const out = await resolveDataSource(ref({ sheetIndex: 0, sheetId: "id-A" }));
    expect(out.sheetIndex).toBe(2);
    listIs([sheet(0, "X", "id-X")]);
    await expect(resolveDataSource(ref({ sheetIndex: 0, sheetId: "id-A" }))).rejects.toThrow(
      SOURCE_SHEET_MISSING_MESSAGE,
    );
  });
});

describe("the id -> index cache", () => {
  it("is not a cache at all until the invalidation is installed (every resolve reads)", async () => {
    await resolveRangeRefSheet(ref({ sheetId: "id-A" }));
    await resolveRangeRefSheet(ref({ sheetId: "id-B" }));
    expect(h.getSheets).toHaveBeenCalledTimes(2);
  });

  it("shares ONE getSheets() across resolves while installed", async () => {
    uninstall = installSheetIdCacheInvalidation();
    await Promise.all([
      resolveRangeRefSheet(ref({ sheetId: "id-A" })),
      resolveRangeRefSheet(ref({ sheetId: "id-B" })),
    ]);
    await resolveRangeRefSheet(ref({ sheetId: "id-A" }));
    expect(h.getSheets).toHaveBeenCalledTimes(1);
  });

  it.each(sheetIdCacheInvalidatingEvents().map((e) => [e]))(
    "is dropped on %s, so the next resolve sees the new sheet list",
    async (eventName) => {
      uninstall = installSheetIdCacheInvalidation();
      expect((await resolveRangeRefSheet(ref({ sheetIndex: 1, sheetId: "id-B" }))).sheetIndex).toBe(1);

      // Sheet1 is deleted: Sheet2 (id-B) shifts down to index 0.
      listIs([sheet(0, "Sheet2", "id-B")]);
      // Without an event the cached answer stands.
      expect((await resolveRangeRefSheet(ref({ sheetIndex: 1, sheetId: "id-B" }))).sheetIndex).toBe(1);

      emitAppEvent(eventName);
      await settle();
      expect((await resolveRangeRefSheet(ref({ sheetIndex: 1, sheetId: "id-B" }))).sheetIndex).toBe(0);
    },
  );

  it("covers exactly the six sheet-collection / document events", () => {
    expect(new Set(sheetIdCacheInvalidatingEvents())).toEqual(
      new Set([
        AppEvents.SHEET_CHANGED,
        AppEvents.SHEET_ADDED,
        AppEvents.SHEET_DELETED,
        AppEvents.SHEET_RENAMED,
        AppEvents.AFTER_OPEN,
        AppEvents.AFTER_NEW,
      ]),
    );
  });

  it("stops caching (and listening) after the cleanup", async () => {
    uninstall = installSheetIdCacheInvalidation();
    await loadSheetIdMap();
    uninstall();
    uninstall = null;
    h.getSheets.mockClear();
    await resolveRangeRefSheet(ref({ sheetId: "id-A" }));
    await resolveRangeRefSheet(ref({ sheetId: "id-A" }));
    expect(h.getSheets).toHaveBeenCalledTimes(2);
  });

  it("never caches a failed read", async () => {
    uninstall = installSheetIdCacheInvalidation();
    h.getSheets.mockRejectedValueOnce(new Error("backend down"));
    await expect(resolveRangeRefSheet(ref({ sheetId: "id-A" }))).rejects.toThrow("backend down");
    expect((await resolveRangeRefSheet(ref({ sheetId: "id-A" }))).sheetIndex).toBe(0);
  });
});

describe("peekRangeRefSheetIndex (the synchronous answer the cell-change listener needs)", () => {
  it("is the stored index for a ref without an id", () => {
    expect(peekRangeRefSheetIndex(ref({ sheetIndex: 3 }))).toBe(3);
  });

  it("is null (unknown -> invalidate) on a cold cache, and warms it for next time", async () => {
    uninstall = installSheetIdCacheInvalidation();
    expect(peekRangeRefSheetIndex(ref({ sheetId: "id-B" }))).toBeNull();
    await settle();
    expect(peekRangeRefSheetIndex(ref({ sheetId: "id-B" }))).toBe(1);
  });

  it("is null for an id whose sheet is gone, and for a non-range source", async () => {
    uninstall = installSheetIdCacheInvalidation();
    await loadSheetIdMap();
    expect(peekRangeRefSheetIndex(ref({ sheetId: "id-GONE" }))).toBeNull();
    expect(peekRangeRefSheetIndex("Sheet1!A1:B5")).toBeNull();
  });
});

describe("A1 strings keep their old rules", () => {
  it("a sheet-qualified string resolves BY NAME (case-insensitive)", async () => {
    const out = await resolveDataSource("'sheet2'!$A$1:$B$5");
    expect(out).toEqual({ sheetIndex: 1, startRow: 0, startCol: 0, endRow: 4, endCol: 1 });
  });

  it("an unqualified string means the ACTIVE sheet", async () => {
    h.gridState = { sheetContext: { activeSheetIndex: 1, activeSheetName: "Sheet2" } };
    expect((await resolveDataSource("A1:B5")).sheetIndex).toBe(1);
  });

  // Found live 2026-09-29 (e2e fixall-calp R5): a chart over a sheet named
  // Rock'!Roll never plotted, even for its publisher. The parser stripped the
  // outer quotes but left the doubled quote doubled, and asked for a sheet
  // called Rock''!Roll.
  it("a quoted name with an escaped quote and a '!' inside resolves to that sheet", async () => {
    listIs([sheet(0, "Sheet1", "id-A"), sheet(1, "Rock'!Roll", "id-R")]);
    const out = await resolveDataSource("'Rock''!Roll'!$A$1:$B$3");
    expect(out).toEqual({ sheetIndex: 1, startRow: 0, startCol: 0, endRow: 2, endCol: 1 });
  });
});

// ============================================================================
// The id a PUBLISH stamps onto a ref whose index names no publisher sheet
// ============================================================================
//
// `stamp_chart_spec_sheet_ids` (core/calp/src/chart_refs.rs) stamps an
// index-only ref that no sheet of the publisher's workbook answers with
// `UNRESOLVABLE_SHEET_ID`, instead of leaving it id-less. Id-less, the
// subscriber's load migration stamped it from ITS sheet at that index, and a
// chart that errored for its publisher silently charted the subscriber's own
// sheet. The contract lives on this side: a non-empty id is "stamped" (the
// migration leaves it alone) and an id no sheet carries is REFUSED (never a
// fall back to the index). The constant is read from the Rust source, so the
// two sides cannot drift apart.

const CHART_REFS_RS = path.resolve(__dirname, "../../../../../core/calp/src/chart_refs.rs");

/** The canonical uuid text of the Rust constant (`SheetId::from_bytes([0xff; 16])`). */
function unresolvableSheetId(): string {
  const src = fs.readFileSync(CHART_REFS_RS, "utf8");
  const m = src.match(/pub const UNRESOLVABLE_SHEET_ID: SheetId = SheetId::from_bytes\(\[0x([0-9a-f]{2}); 16\]\);/);
  if (!m) throw new Error("UNRESOLVABLE_SHEET_ID is no longer a repeated-byte constant in chart_refs.rs");
  const hex = m[1].repeat(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe("a ref the publisher stamped UNRESOLVABLE", () => {
  it("is read from the Rust constant, and it is not the nil id a default could produce", () => {
    const id = unresolvableSheetId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("is left alone by the load migration -- it counts as stamped", () => {
    const spec = {
      mark: "bar",
      data: ref({ sheetIndex: 0, sheetId: unresolvableSheetId() }),
    } as unknown as ChartSpec;
    // An index -> id lookup that WOULD answer index 0 with the subscriber's sheet.
    expect(stampSpecSheetIds(spec, () => "id-A")).toBe(spec);
  });

  it("is refused by the resolver even though its index names one of the subscriber's sheets", async () => {
    // Index 0 is Sheet1 (id-A) here: exactly the sheet a fall back would chart.
    const p = resolveRangeRefSheet(ref({ sheetIndex: 0, sheetId: unresolvableSheetId() }));
    await expect(p).rejects.toBeInstanceOf(SourceSheetMissingError);
  });
});
