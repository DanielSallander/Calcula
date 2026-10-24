//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/deferredActionHostActivate.test.ts
// PURPOSE: A notebook's deferred sheet switch tells Core the sheet the backend
//          landed on -- found by its TRUE index FIELD, never by list position --
//          with that sheet's name AND its STABLE id.
// CONTEXT: Review F1-rename-refuses-entry (round 5): Core's sheet context now
//          carries the active sheet's stable id, and an open cell edit follows
//          its sheet by it. This door read the landed sheet as
//          `result.sheets[result.activeIndex]` -- a list POSITION -- which names
//          another sheet once an object-backed sheet (a floating range's cell
//          store) is absent from the list; handing Core THAT sheet's id would
//          mislead every identity decision, so the lookup is by the index field.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  dispatched: [] as unknown[],
  backendResult: {
    // Index 2 is an object-backed sheet: absent from the list, indices stay TRUE.
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "id-data" },
      { index: 1, name: "Costs", visibility: "visible", sheetId: "id-costs" },
      { index: 3, name: "Report", visibility: "visible", sheetId: "id-report" },
    ],
    activeIndex: 3,
  },
}));

vi.mock("@api/gridDispatch", () => ({
  dispatchGridAction: (action: unknown) => {
    h.dispatched.push(action);
  },
}));
vi.mock("@api/grid", async () => {
  const actions = await vi.importActual<typeof import("@api/grid")>("@api/grid");
  return {
    getGridStateSnapshot: () => null,
    setSelection: vi.fn(),
    scrollToCell: vi.fn(),
    // The REAL creator: what reaches Core is the payload it builds.
    setActiveSheet: actions.setActiveSheet,
    setStatusBarText: vi.fn(),
    clearStatusBarText: vi.fn(),
    changeViewMode: vi.fn(),
    changeReferenceStyle: vi.fn(),
    setZoomLevel: vi.fn(),
    fillDown: vi.fn(),
    fillRight: vi.fn(),
  };
});
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn(), AppEvents: { SHEET_CHANGED: "app:sheet-changed" } }));
vi.mock("@api/cellEvents", () => ({ cellEvents: { emit: vi.fn() } }));
vi.mock("@api/lib", () => ({
  setActiveSheet: vi.fn(async () => h.backendResult),
  hideSheet: vi.fn(),
  unhideSheet: vi.fn(),
  setScrollArea: vi.fn(),
  setIterationSettings: vi.fn(),
  applyNamedStyle: vi.fn(),
  applyNamedStyleRange: vi.fn(),
  calculateNow: vi.fn(),
}));

import { liveDeferredActionHost } from "../deferredActionHost";

beforeEach(() => {
  h.dispatched.length = 0;
});

describe("liveDeferredActionHost.activateSheet", () => {
  it("tells Core the landed sheet by its index FIELD, with its name and stable id -- not the sheet at that list position", async () => {
    await liveDeferredActionHost.activateSheet(3);
    expect(h.dispatched, "Core was told another sheet's name or id").toEqual([
      { type: "SET_ACTIVE_SHEET", payload: { index: 3, name: "Report", sheetId: "id-report" } },
    ]);
  });
});
