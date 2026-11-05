//! FILENAME: app/src/api/__tests__/autoFilterFilterMode.test.ts
// PURPOSE: isActiveSheetFilterMode answers Excel's Worksheet.FilterMode -- the
//          question AutoSum (SUBTOTAL for Sum) and Ctrl+Enter (skip hidden rows
//          and columns) both change on (rev-ui-3 / rev-ui-4).
// CONTEXT: Measured live 2026-11-05 (Excel 16, lane uic probe1..probe3): a
//          filter whose criteria hide NOTHING still switches both gestures; a
//          filter with its buttons showing but no criteria does not; an
//          in-place Advanced Filter does. Rows hidden by hand are not filter
//          mode -- and the backend's get_hidden_rows never reports them (only
//          the AutoFilter's and the Advanced Filter's).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  autoFilter: null as null | { enabled: boolean; isDataFiltered: boolean },
  hidden: [] as number[],
  fail: false,
}));

vi.mock("../backend", () => ({
  getAutoFilter: vi.fn(async () => {
    if (h.fail) throw new Error("backend down");
    return h.autoFilter;
  }),
  getHiddenRows: vi.fn(async () => {
    if (h.fail) throw new Error("backend down");
    return h.hidden;
  }),
}));

import { isActiveSheetFilterMode } from "../autoFilterService";

describe("isActiveSheetFilterMode (Excel's Worksheet.FilterMode)", () => {
  beforeEach(() => {
    h.autoFilter = null;
    h.hidden = [];
    h.fail = false;
  });

  it("an AutoFilter with criteria -- even criteria that hide no row -- is filter mode", async () => {
    h.autoFilter = { enabled: true, isDataFiltered: true };
    expect(await isActiveSheetFilterMode()).toBe(true);
  });

  it("an AutoFilter whose buttons show but which filters nothing is not", async () => {
    h.autoFilter = { enabled: true, isDataFiltered: false };
    expect(await isActiveSheetFilterMode()).toBe(false);
  });

  it("no filter at all is not", async () => {
    expect(await isActiveSheetFilterMode()).toBe(false);
  });

  it("an in-place Advanced Filter (rows it hides, no AutoFilter criteria) is", async () => {
    h.autoFilter = { enabled: true, isDataFiltered: false };
    h.hidden = [3];
    expect(await isActiveSheetFilterMode()).toBe(true);
  });

  it("a failed read answers false (the unfiltered behaviour)", async () => {
    h.fail = true;
    expect(await isActiveSheetFilterMode()).toBe(false);
  });
});
