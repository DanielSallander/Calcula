//! FILENAME: app/extensions/Pivot/lib/__tests__/valueFieldDialogRequest.test.ts
// PURPOSE: The value-field dialog contract (lib/valueFieldDialogRequest.ts):
//          `requestValueFieldDialog` stores the request as PENDING, calls the
//          ONE host hook (`openPivotPaneForPivot`) exactly once, and only then
//          announces it; the pending request survives until the editor takes
//          it; a failed host drops it (no stale modal later). Plus the mapping
//          of a value-field index to the editor's Values zone (calculated
//          fields not counted), and the host hook's two branches.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  emitted: [] as Array<[string, unknown]>,
  hostImpl: null as null | ((pivotId: string) => Promise<void>),
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn((name: string, detail: unknown) => {
    h.order.push("emit");
    h.emitted.push([name, detail]);
  }),
}));
vi.mock("../../handlers/selectionHandler", () => ({
  openPivotPaneForPivot: vi.fn((pivotId: string) => {
    h.order.push("host");
    return h.hostImpl ? h.hostImpl(pivotId) : Promise.resolve();
  }),
}));

import {
  requestValueFieldDialog,
  takePendingValueFieldDialog,
  valuesZoneIndexOf,
  __resetValueFieldDialogRequestsForTests,
} from "../valueFieldDialogRequest";
import { openPivotPaneForPivot } from "../../handlers/selectionHandler";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";

beforeEach(() => {
  __resetValueFieldDialogRequestsForTests();
  h.order = [];
  h.emitted = [];
  h.hostImpl = null;
  vi.mocked(openPivotPaneForPivot).mockClear();
});

describe("requestValueFieldDialog", () => {
  it("stores, calls the host hook exactly once, then announces", async () => {
    let pendingDuringHost: unknown = "unset";
    h.hostImpl = async (pivotId) => {
      // The pending request is already stored when the pane opens: an editor
      // that mounts while the hook runs can take it.
      pendingDuringHost = takePendingValueFieldDialog(pivotId);
    };
    await requestValueFieldDialog({ pivotId: "p1", valueFieldIndex: 2, dialog: "settings" });
    expect(openPivotPaneForPivot).toHaveBeenCalledTimes(1);
    expect(openPivotPaneForPivot).toHaveBeenCalledWith("p1");
    expect(h.order).toEqual(["host", "emit"]);
    expect(pendingDuringHost).toEqual({ pivotId: "p1", valueFieldIndex: 2, dialog: "settings" });
    expect(h.emitted).toEqual([
      [PivotEvents.PIVOT_OPEN_VALUE_FIELD_DIALOG, { pivotId: "p1", valueFieldIndex: 2, dialog: "settings" }],
    ]);
  });

  it("the pending request survives until the editor takes it, once, for its own pivot", async () => {
    await requestValueFieldDialog({ pivotId: "p1", valueFieldIndex: 0, dialog: "numberFormat" });
    expect(takePendingValueFieldDialog("p2"), "another pivot's editor takes nothing").toBeNull();
    expect(takePendingValueFieldDialog("p1")).toEqual({ pivotId: "p1", valueFieldIndex: 0, dialog: "numberFormat" });
    expect(takePendingValueFieldDialog("p1"), "taken once").toBeNull();
  });

  it("the newest request for a pivot wins; each request calls the host once", async () => {
    await requestValueFieldDialog({ pivotId: "p1", valueFieldIndex: 0, dialog: "numberFormat" });
    await requestValueFieldDialog({ pivotId: "p1", valueFieldIndex: 1, dialog: "settings" });
    expect(openPivotPaneForPivot).toHaveBeenCalledTimes(2);
    expect(takePendingValueFieldDialog("p1")).toEqual({ pivotId: "p1", valueFieldIndex: 1, dialog: "settings" });
  });

  it("a host that fails drops the request and rejects; nothing is announced", async () => {
    h.hostImpl = () => Promise.reject(new Error("the PivotTable is not on this sheet"));
    await expect(
      requestValueFieldDialog({ pivotId: "p1", valueFieldIndex: 0, dialog: "settings" }),
    ).rejects.toThrow("not on this sheet");
    expect(takePendingValueFieldDialog("p1")).toBeNull();
    expect(h.emitted).toEqual([]);
  });
});

describe("valuesZoneIndexOf", () => {
  const zone = [{}, { isCalculated: true }, {}, { isCalculated: true }, {}];
  it("maps the i-th value field past interleaved calculated fields", () => {
    expect(valuesZoneIndexOf(zone, 0)).toBe(0);
    expect(valuesZoneIndexOf(zone, 1)).toBe(2);
    expect(valuesZoneIndexOf(zone, 2)).toBe(4);
  });
  it("answers -1 for an index that names no value field", () => {
    expect(valuesZoneIndexOf(zone, 3)).toBe(-1);
    expect(valuesZoneIndexOf(zone, -1)).toBe(-1);
    expect(valuesZoneIndexOf(zone, 0.5)).toBe(-1);
    expect(valuesZoneIndexOf([], 0)).toBe(-1);
  });
});
