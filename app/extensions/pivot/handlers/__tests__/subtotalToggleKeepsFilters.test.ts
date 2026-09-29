//! FILENAME: app/extensions/Pivot/handlers/__tests__/subtotalToggleKeepsFilters.test.ts
// PURPOSE: The context menu's Subtotal "<field>" toggle keeps the item filters
//          of every field in the zone (found in review round 3 next to finding
//          2: the same "update_pivot_fields rebuilds what it is given" class).
//
//          The toggle already sent the whole zone, but each field WITHOUT its
//          hidden items, and `update_pivot_fields` built a field sent without
//          a list as one that hides nothing: toggling Product's subtotals
//          cleared Region's filter. Round 3 made the toggle echo every list;
//          since BUG-0184 the command KEEPS whatever it is not sent (pinned in
//          pivot/regression_tests.rs), so the toggle sends the zone and the
//          one flipped setting only -- an echoed list could only race a filter
//          changed since the click.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  items: [] as Array<{ id: string; onClick: (ctx: unknown) => Promise<void> }>,
  sent: [] as unknown[],
}));

vi.mock("@api", () => ({
  gridExtensions: {
    registerContextMenuItems: (items: typeof h.items) => {
      h.items = items;
    },
    unregisterContextMenuItem: vi.fn(),
  },
  showDialog: vi.fn(),
  closeTaskPane: vi.fn(),
  openTaskPane: vi.fn(),
  markTaskPaneManuallyClosed: vi.fn(),
  clearTaskPaneManuallyClosed: vi.fn(),
  getTaskPaneManuallyClosed: () => [],
}));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn() }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(), promptAsync: vi.fn() }));
vi.mock("../../lib/pivotViewStore", () => ({ deleteCachedPivotView: vi.fn() }));
vi.mock("../../manifest", () => ({
  PIVOT_GROUP_DIALOG_ID: "g",
  PIVOT_FIELD_SETTINGS_DIALOG_ID: "fs",
  PIVOT_OPTIONS_DIALOG_ID: "o",
  PIVOT_DRILL_BEHAVIOR_DIALOG_ID: "d",
  PIVOT_PANE_ID: "p",
}));
vi.mock("../pivotContextMenuHelpers", () => ({
  isInPivotRegion: () => true,
  isDimensionHeader: () => true,
  getPivotIdFromContext: () => "p1",
  getFieldNameForCell: () => "Product",
  getFieldIndexForCell: () => 1,
  getItemLabelForCell: () => null,
  getClickedCellData: () =>
    Promise.resolve({
      pivotInfo: {
        pivotId: "p1",
        fieldConfiguration: {
          rowFields: [
            { sourceIndex: 0, name: "Region", isNumeric: false, hiddenItems: ["West"] },
            { sourceIndex: 1, name: "Product", isNumeric: false, hiddenItems: ["Pens"] },
          ],
          columnFields: [],
          valueFields: [],
          filterFields: [],
          layout: {},
        },
      },
      cell: { cellType: "RowHeader", groupPath: [[1, 0]] },
      viewRow: 2,
      viewCol: 0,
    }),
}));
vi.mock("../../lib/pivot-api", () => ({
  refreshPivotCache: vi.fn(),
  deletePivotTable: vi.fn(),
  sortPivotField: vi.fn(),
  applyPivotFilter: vi.fn(),
  getPivotFieldUniqueValues: vi.fn(),
  expandCollapseLevel: vi.fn(),
  expandCollapseAll: vi.fn(),
  setPivotItemExpanded: vi.fn(),
  ungroupPivotField: vi.fn(),
  removePivotHierarchy: vi.fn(),
  getPivotFieldInfo: vi.fn(() => Promise.resolve({ subtotals: { automatic: true } })),
  updatePivotFields: vi.fn((req: unknown) => {
    h.sent.push(req);
    return Promise.resolve({});
  }),
  updatePivotProperties: vi.fn(),
}));

import { registerPivotContextMenuItems } from "../pivotContextMenu";

beforeEach(() => {
  h.items = [];
  h.sent = [];
});

describe('Subtotal "<field>" from the context menu', () => {
  it("sends the whole zone with only the clicked field's subtotals flipped, echoing no item filter", async () => {
    registerPivotContextMenuItems();
    const toggle = h.items.find((i) => i.id === "pivot:subtotal")!;
    await toggle.onClick({ clickedCell: { row: 3, col: 0 } });

    expect(h.sent).toEqual([
      {
        pivotId: "p1",
        rowFields: [
          { sourceIndex: 0, name: "Region" },
          { sourceIndex: 1, name: "Product", showSubtotals: false },
        ],
      },
    ]);
  });
});
