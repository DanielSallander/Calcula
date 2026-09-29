//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotOverwriteConfirm.test.ts
// PURPOSE: The pivot "will overwrite existing data" question on every refresh
//          door (Refresh, Refresh All, a field edit / BI re-query) is asked
//          through `confirmAsync` and AWAITED, and it fails CLOSED.
//
//          It is asked AFTER the command, only when the backend's response
//          counts overwritten cells -- the backend counts 0 for a canvas pivot
//          and for a BI pivot's own output (a reopened one included, via its
//          saved output extent), so those refreshes never ask.
//
//          It used to call the dialog plugin's `ask` directly. `ask` THROWS
//          when the dialog cannot be shown, and every caller's catch then
//          skipped `undo_pivot_overwrite`: the user's cells stayed overwritten
//          without an answer. A refusal -- including "could not ask" -- now
//          undoes the overwrite.
//
// The dialog double has the Tauri shape: `confirmAsync` returns a Promise.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  refreshAll: vi.fn(),
  updateBi: vi.fn(),
  applyFilter: vi.fn(),
  changeSource: vi.fn(),
  undoOverwrite: vi.fn(() => Promise.resolve()),
  confirm: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshPivotCache: (...a: unknown[]) => h.refresh(...a),
  refreshAllPivotTables: (...a: unknown[]) => h.refreshAll(...a),
  updateBiPivotFields: (...a: unknown[]) => h.updateBi(...a),
  applyPivotFilter: (...a: unknown[]) => h.applyFilter(...a),
  changePivotDataSource: (...a: unknown[]) => h.changeSource(...a),
  undoPivotOverwrite: (...a: unknown[]) => h.undoOverwrite(...a),
  cancelPivotOperation: () => Promise.resolve(),
  revertPivotOperation: () => Promise.resolve(),
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => h.confirm(...a) }));
vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import {
  refreshPivotCache,
  refreshAllPivotTables,
  updateBiFields,
  applyPivotFilter,
  changePivotDataSource,
} from "../pivot-api";

/** A response; an overwriting one names its undo step (its `overwriteToken`),
 *  as the backend does for every command that records the overwritten cells. */
const view = (pivotId: string, overwrittenCellCount: number, overwriteToken?: number) => ({
  pivotId,
  version: 1,
  rowCount: 1,
  colCount: 1,
  rows: [],
  overwrittenCellCount,
  ...(overwriteToken === undefined ? {} : { overwriteToken }),
});

beforeEach(() => {
  h.refresh.mockReset();
  h.refreshAll.mockReset();
  h.updateBi.mockReset();
  h.applyFilter.mockReset();
  h.changeSource.mockReset();
  h.undoOverwrite.mockClear();
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("Refresh (refreshPivotCache)", () => {
  it("asks through confirmAsync when the backend counts overwritten cells; a refusal undoes the overwrite", async () => {
    h.refresh.mockImplementation(() => Promise.resolve(view("pv-1", 3, 41)));

    await expect(refreshPivotCache("pv-1")).rejects.toThrow(/would overwrite data/);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toBe(
      "A PivotTable report will overwrite existing data. Do you want to continue?",
    );
    expect(h.undoOverwrite).toHaveBeenCalledWith("pv-1", [41]);
  });

  it("an OK keeps the refresh and undoes nothing", async () => {
    h.refresh.mockImplementation(() => Promise.resolve(view("pv-2", 3)));
    h.confirm.mockImplementation(() => Promise.resolve(true));

    await expect(refreshPivotCache("pv-2")).resolves.toMatchObject({ pivotId: "pv-2" });
    expect(h.undoOverwrite).not.toHaveBeenCalled();
  });

  it("never asks when the backend counts 0 (a canvas pivot, a BI pivot's own output)", async () => {
    h.refresh.mockImplementation(() => Promise.resolve(view("pv-3", 0)));

    await expect(refreshPivotCache("pv-3")).resolves.toMatchObject({ pivotId: "pv-3" });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undoOverwrite).not.toHaveBeenCalled();
  });
});

describe("Refresh All (refreshAllPivotTables)", () => {
  it("asks through confirmAsync for the pivot that overwrote; a refusal undoes it", async () => {
    h.refreshAll.mockImplementation(() => Promise.resolve([view("pv-a", 0), view("pv-b", 2, 42)]));

    await expect(refreshAllPivotTables()).rejects.toThrow(/would overwrite data/);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undoOverwrite).toHaveBeenCalledWith("pv-b", [42]);
  });
});

describe("a BI re-query (updateBiFields)", () => {
  it("asks through confirmAsync; a refusal undoes the overwrite", async () => {
    h.updateBi.mockImplementation(() => Promise.resolve(view("pv-bi", 5, 43)));

    await expect(
      updateBiFields({ pivotId: "pv-bi", rowFields: [], columnFields: [], valueFields: [], filterFields: [] }),
    ).rejects.toThrow(/would overwrite data/);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undoOverwrite).toHaveBeenCalledWith("pv-bi", [43]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 5: a Cancel takes back THIS command's step and nothing else
// ---------------------------------------------------------------------------

describe("the header dropdown's filter (applyPivotFilter)", () => {
  it("a refusal hands back exactly the filter's own overwrite step", async () => {
    h.applyFilter.mockImplementation(() => Promise.resolve(view("pv-f", 2, 44)));

    await expect(
      applyPivotFilter({ pivotId: "pv-f", fieldIndex: 0, filters: { manualFilter: { selectedItems: ["East"] } } }),
    ).rejects.toThrow(/would overwrite data/);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undoOverwrite).toHaveBeenCalledWith("pv-f", [44]);
  });

  it("a command that named NO step takes nothing back on Cancel (it used to pop the user's previous step)", async () => {
    h.applyFilter.mockImplementation(() => Promise.resolve(view("pv-g", 2)));

    await expect(
      applyPivotFilter({ pivotId: "pv-g", fieldIndex: 0, filters: { manualFilter: { selectedItems: ["East"] } } }),
    ).rejects.toThrow(/would overwrite data/);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undoOverwrite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave D fix-up: Change Data Source asks too
// ---------------------------------------------------------------------------

describe("Change Data Source (changePivotDataSource)", () => {
  // A pivot repointed at a larger range grows over the user's cells. The
  // backend saves them and names the step, but this door never asked: the
  // cells were overwritten with no question, as no other pivot door does.
  it("asks through confirmAsync when the backend counts overwritten cells; a refusal takes back its step", async () => {
    h.changeSource.mockImplementation(() => Promise.resolve(view("pv-cs", 4, 45)));

    await expect(changePivotDataSource({ pivotId: "pv-cs", sourceRange: "Sheet1!A1:C40" })).rejects.toThrow(
      /would overwrite data/,
    );
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undoOverwrite).toHaveBeenCalledWith("pv-cs", [45]);
  });

  it("an OK keeps the change; a change that overwrites nothing never asks", async () => {
    h.confirm.mockImplementation(() => Promise.resolve(true));
    h.changeSource.mockImplementation(() => Promise.resolve(view("pv-cs2", 4, 46)));
    await expect(changePivotDataSource({ pivotId: "pv-cs2", sourceRange: "A1:C40" })).resolves.toMatchObject({
      pivotId: "pv-cs2",
    });
    expect(h.undoOverwrite).not.toHaveBeenCalled();

    h.confirm.mockClear();
    h.changeSource.mockImplementation(() => Promise.resolve(view("pv-cs3", 0)));
    await expect(changePivotDataSource({ pivotId: "pv-cs3", sourceRange: "A1:C4" })).resolves.toMatchObject({
      pivotId: "pv-cs3",
    });
    expect(h.confirm).not.toHaveBeenCalled();
  });
});