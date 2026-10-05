//! FILENAME: app/extensions/AutoFilter/__tests__/autoFilterRibbonState.test.ts
// PURPOSE: What the Home tab's Sort & Filter menu needs from AutoFilter, through
//          the feature-neutral @api/autoFilterService seam:
//            - onChange(listener): the Filter row is CHECKED while the sheet has
//              a filter, and Clear / Reapply are ENABLED only while data is
//              filtered -- without polling;
//            - autofilter.clear / autofilter.reapply commands, and the
//              controller's reapply().
// CONTEXT: Home tab 2026-10-04. The change events were private to this
//          extension (lib/filterEvents.ts) and Clear / Reapply existed only as
//          Data-menu actions with no command id. Enablement measured in live
//          Excel 2026-10-04: Clear and Reapply are disabled with a filter that
//          hides nothing, and enabled once a criteria is applied; Filter shows
//          pressed whenever the sheet has a filter.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  applyAutoFilter: vi.fn(),
  removeAutoFilter: vi.fn(),
  clearAutoFilterCriteria: vi.fn(),
  reapplyAutoFilter: vi.fn(),
  setColumnFilterValues: vi.fn(),
  getAutoFilter: vi.fn(async () => null),
  getHiddenRows: vi.fn(async () => []),
  menuPatches: [] as Array<{ menu: string; item: string; patch: Record<string, unknown> }>,
  toasts: [] as string[],
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  applyAutoFilter: (...a: unknown[]) => h.applyAutoFilter(...a),
  removeAutoFilter: (...a: unknown[]) => h.removeAutoFilter(...a),
  clearAutoFilterCriteria: (...a: unknown[]) => h.clearAutoFilterCriteria(...a),
  reapplyAutoFilter: (...a: unknown[]) => h.reapplyAutoFilter(...a),
  setColumnFilterValues: (...a: unknown[]) => h.setColumnFilterValues(...a),
  getAutoFilter: (...a: unknown[]) => h.getAutoFilter(...(a as [])),
  getHiddenRows: (...a: unknown[]) => h.getHiddenRows(...(a as [])),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  setHiddenRows: vi.fn(),
  dispatchGridAction: vi.fn(),
  updateMenuItem: (menu: string, item: string, patch: Record<string, unknown>) =>
    h.menuPatches.push({ menu, item, patch }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    h.toasts.push(message);
  },
}));

import {
  createAutoFilterController,
  resetState,
  setColumnValueFilter,
  applyFilterToRange,
  clearFilterCriteria,
  removeFilter,
} from "../lib/filterStore";
import {
  onChange,
  getAutoFilterStatus,
  type AutoFilterStatus,
} from "@api/autoFilterService";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { bindDataMenuState } from "../handlers/dataMenuBuilder";
import { registerAutoFilterCommands } from "../lib/filterCommands";

function info(over: Record<string, unknown> = {}) {
  return {
    id: "af",
    startRow: 0,
    startCol: 0,
    endRow: 9,
    endCol: 2,
    enabled: true,
    isDataFiltered: false,
    criteria: [null, null, null],
    ...over,
  };
}
const ok = (over: Record<string, unknown> = {}, hiddenRows: number[] = []) => ({
  success: true,
  autoFilter: info(over),
  hiddenRows,
  visibleRows: [],
});

let heard: AutoFilterStatus[] = [];
let off: () => void = () => {};
let unregisterCommands: () => void = () => {};

beforeAll(() => {
  unregisterCommands = registerAutoFilterCommands({
    register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
    unregister: (id: string) => CommandRegistry.unregister(id),
  });
});
afterAll(() => unregisterCommands());

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  heard = [];
  h.menuPatches = [];
  h.toasts = [];
  off = onChange((s) => heard.push(s));
});
afterEach(() => off());

describe("onChange: the seam tells the ribbon what changed", () => {
  it("turning a filter on, filtering, clearing and removing each announce once", async () => {
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    h.setColumnFilterValues.mockResolvedValue(ok({ isDataFiltered: true }, [3, 4]));
    await setColumnValueFilter(1, ["x"], false);
    h.clearAutoFilterCriteria.mockResolvedValue(ok());
    await clearFilterCriteria(null);
    h.removeAutoFilter.mockResolvedValue({ success: true, hiddenRows: [], visibleRows: [] });
    await removeFilter();

    expect(heard).toEqual([
      { hasFilter: true, isDataFiltered: false },
      { hasFilter: true, isDataFiltered: true },
      { hasFilter: true, isDataFiltered: false },
      { hasFilter: false, isDataFiltered: false },
    ]);
    expect(getAutoFilterStatus()).toEqual({ hasFilter: false, isDataFiltered: false });
  });

  it("is silent when nothing changed (no polling, no echo)", async () => {
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    await applyFilterToRange(0, 0, 9, 2);
    expect(heard).toHaveLength(1);
  });

  it("an unsubscribed listener hears nothing", async () => {
    off();
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    expect(heard).toEqual([]);
  });
});

describe("the controller's reapply()", () => {
  it("re-runs the filter and adopts the result (cache, hidden rows, status)", async () => {
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    h.reapplyAutoFilter.mockResolvedValue(ok({ isDataFiltered: true }, [5]));
    const snap = await createAutoFilterController().reapply();
    expect(snap.hiddenRows).toEqual([5]);
    expect(getAutoFilterStatus()).toEqual({ hasFilter: true, isDataFiltered: true });
  });

  it("rejects a refusal instead of resolving quietly", async () => {
    h.reapplyAutoFilter.mockResolvedValue({ success: false, error: "No AutoFilter exists", hiddenRows: [], visibleRows: [] });
    await expect(createAutoFilterController().reapply()).rejects.toThrow(/No AutoFilter/);
  });
});

describe("autofilter.clear / autofilter.reapply", () => {
  it("are registered under the contract's ids", () => {
    expect(CommandRegistry.has(ExtensionCommands.FILTER_CLEAR)).toBe(true);
    expect(CommandRegistry.has(ExtensionCommands.FILTER_REAPPLY)).toBe(true);
  });

  it("clear stops every column's criteria (the filter itself stays)", async () => {
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    h.clearAutoFilterCriteria.mockResolvedValue(ok());
    await CommandRegistry.execute(ExtensionCommands.FILTER_CLEAR);
    expect(h.clearAutoFilterCriteria).toHaveBeenCalledTimes(1);
    expect(h.removeAutoFilter).not.toHaveBeenCalled();
  });

  it("reapply re-runs the backend filter", async () => {
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    h.reapplyAutoFilter.mockResolvedValue(ok());
    await CommandRegistry.execute(ExtensionCommands.FILTER_REAPPLY);
    expect(h.reapplyAutoFilter).toHaveBeenCalledTimes(1);
  });

  it("with no filter on the sheet, both say so and touch nothing", async () => {
    await CommandRegistry.execute(ExtensionCommands.FILTER_CLEAR);
    await CommandRegistry.execute(ExtensionCommands.FILTER_REAPPLY);
    expect(h.clearAutoFilterCriteria).not.toHaveBeenCalled();
    expect(h.reapplyAutoFilter).not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(2);
  });

  it("a refusal (protected sheet) reaches the user", async () => {
    h.applyAutoFilter.mockResolvedValue(ok());
    await applyFilterToRange(0, 0, 9, 2);
    h.clearAutoFilterCriteria.mockResolvedValue({ success: false, error: "This sheet is protected", hiddenRows: [], visibleRows: [] });
    await CommandRegistry.execute(ExtensionCommands.FILTER_CLEAR);
    expect(h.toasts).toEqual(["This sheet is protected"]);
  });
});

describe("the Data menu follows the same state (live-Excel enablement)", () => {
  it("Filter is checked while a filter exists; Clear / Reapply enable only while data is filtered", async () => {
    const unbind = bindDataMenuState();
    try {
      const last = (item: string) =>
        [...h.menuPatches].reverse().find((p) => p.menu === "data" && p.item === item)?.patch;
      // Initial state: no filter.
      expect(last("data:filter")).toEqual({ checked: false });
      expect(last("data:clearFilter")).toEqual({ disabled: true });
      expect(last("data:reapply")).toEqual({ disabled: true });

      h.applyAutoFilter.mockResolvedValue(ok());
      await applyFilterToRange(0, 0, 9, 2);
      expect(last("data:filter")).toEqual({ checked: true });
      expect(last("data:clearFilter")).toEqual({ disabled: true });

      h.setColumnFilterValues.mockResolvedValue(ok({ isDataFiltered: true }, [2]));
      await setColumnValueFilter(0, ["a"], false);
      expect(last("data:clearFilter")).toEqual({ disabled: false });
      expect(last("data:reapply")).toEqual({ disabled: false });
    } finally {
      unbind();
    }
  });
});
