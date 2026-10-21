//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfExcelMenu.test.tsx
// PURPOSE: Format > Conditional Formatting is Excel's Home > Conditional
//          Formatting, row by row -- and every row survives the backend saying
//          no.
// CONTEXT: The Home tab hosts THIS tree (RegisteredMenuButton, menu "format",
//          item "format:conditionalFormatting"), so the Format menu and the
//          ribbon show one tree and this file pins it once. Excel's tree was
//          read from live Excel 16 on 2026-10-04 (UI Automation over the open
//          menu, scratchpad styles-probe/cfprobe.ps1):
//
//            Highlight Cells Rules >, Top/Bottom Rules >
//            ---
//            Data Bars >, Color Scales >, Icon Sets >
//            ---
//            New Rule..., Clear Rules >, Manage Rules...
//
//          Highlight: Greater Than... Less Than... Between... Equal To...
//          Text that Contains... A Date Occurring... Duplicate Values... ---
//          More Rules...   Top/Bottom: Top 10 Items... Top 10 %... Bottom 10
//          Items... Bottom 10 %... Above Average... Below Average... --- More
//          Rules...   Clear Rules: from Selected Cells, from Entire Sheet, from
//          This Table, from This PivotTable (the last two DISABLED outside a
//          table / a PivotTable).
//
//          The defects pinned here: Calcula showed Color Scales BEFORE Data
//          Bars, had no "A Date Occurring..." (the backend has supported
//          timePeriod rules all along), no "More Rules..." in either submenu,
//          an extra "Unique Values..." row Excel reaches through Duplicate
//          Values' own dropdown, no This Table / This PivotTable, a gallery
//          pick whose backend refusal became an UNHANDLED promise rejection,
//          and a Clear Rules from Selected Cells that said nothing at all when
//          it cleared nothing (the backend returns the count; the handler
//          dropped it).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  addConditionalFormat: vi.fn(),
  clearConditionalFormatsInRange: vi.fn(),
  showDialog: vi.fn(),
  getTableAtCell: vi.fn(),
  getPivotRegionsForSheet: vi.fn(),
  invalidateAndRefresh: vi.fn(async () => undefined),
  gallery: new Map<string, { onSelect: (...a: unknown[]) => void; onMoreRules: () => void; onClose: () => void }>(),
  capture: (name: string) => (props: { onSelect: (...a: unknown[]) => void; onMoreRules: () => void; onClose: () => void }): null => {
    h.gallery.set(name, props);
    return null;
  },
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
  addConditionalFormat: (...a: unknown[]) => h.addConditionalFormat(...a),
  clearConditionalFormatsInRange: (...a: unknown[]) => h.clearConditionalFormatsInRange(...a),
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getTableAtCell: (...a: unknown[]) => h.getTableAtCell(...a),
  getPivotRegionsForSheet: (...a: unknown[]) => h.getPivotRegionsForSheet(...a),
}));
vi.mock("../cfStore", () => ({ invalidateAndRefresh: () => h.invalidateAndRefresh() }));
vi.mock("../../components/ColorScaleGallery", () => ({ ColorScaleGallery: h.capture("colorScales") }));
vi.mock("../../components/DataBarGallery", () => ({ DataBarGallery: h.capture("dataBars") }));
vi.mock("../../components/IconSetGallery", () => ({ IconSetGallery: h.capture("iconSets") }));

import {
  registerCFMenuItems,
  setMenuSelection,
  refreshClearScopes,
  QUICK_CF_DIALOG_ID,
  NEW_RULE_DIALOG_ID,
} from "../../handlers/homeMenuBuilder";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { subscribeToMenus } from "@api/ui";

interface Item {
  id: string;
  label: string;
  separator?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  action?: () => unknown;
  customContent?: (close: () => void) => React.ReactElement;
  children?: Item[];
}

let top: Item[] = [];
const items = new Map<string, Item>();
const toasts: ToastPayload[] = [];
let container: HTMLDivElement;
let root: Root;
let cleanup: () => void = () => {};

function collect(item: Item): void {
  items.set(item.id, item);
  for (const child of item.children ?? []) collect(child);
}

/** A list as Excel draws it: labels, with "---" for a separator. */
function shape(list: Item[] | undefined): string[] {
  return (list ?? []).map((it) => (it.separator ? "---" : it.label));
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function openGallery(id: string): Promise<void> {
  await act(async () => {
    root.render(items.get(id)!.customContent!(() => {}));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  for (const fn of [h.addConditionalFormat, h.clearConditionalFormatsInRange, h.showDialog, h.getTableAtCell, h.getPivotRegionsForSheet]) {
    fn.mockReset();
  }
  h.invalidateAndRefresh.mockClear();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  h.clearConditionalFormatsInRange.mockResolvedValue(1);
  h.getTableAtCell.mockResolvedValue(null);
  h.getPivotRegionsForSheet.mockResolvedValue([]);
  h.gallery.clear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  items.clear();
  top = [];
  cleanup = registerCFMenuItems({
    ui: {
      menus: {
        registerItem: (_menu: string, item: Item) => {
          top.push(item);
          collect(item);
        },
        unregisterItem: () => undefined,
      },
    },
  } as never);
  setMenuSelection({ startRow: 1, startCol: 1, endRow: 3, endCol: 2 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  cleanup();
  act(() => root.unmount());
  document.body.innerHTML = "";
});

// ============================================================================
// The tree
// ============================================================================

describe("Conditional Formatting: Excel's tree [LIVE 2026-10-04]", () => {
  it("top level: two rule submenus, the three galleries, then New / Clear / Manage", () => {
    expect(shape(items.get("format:conditionalFormatting")!.children)).toEqual([
      "Highlight Cells Rules",
      "Top/Bottom Rules",
      "---",
      "Data Bars",
      "Color Scales",
      "Icon Sets",
      "---",
      "New Rule...",
      "Clear Rules",
      "Manage Rules...",
    ]);
  });

  it("Highlight Cells Rules: Excel's seven rows, then More Rules... (no Unique Values row)", () => {
    expect(shape(items.get("cf:highlightCells")!.children)).toEqual([
      "Greater Than...",
      "Less Than...",
      "Between...",
      "Equal To...",
      "Text that Contains...",
      "A Date Occurring...",
      "Duplicate Values...",
      "---",
      "More Rules...",
    ]);
  });

  it("Top/Bottom Rules: Excel's six rows (Excel spells 'Top 10 %...'), then More Rules...", () => {
    expect(shape(items.get("cf:topBottomRules")!.children)).toEqual([
      "Top 10 Items...",
      "Top 10 %...",
      "Bottom 10 Items...",
      "Bottom 10 %...",
      "Above Average...",
      "Below Average...",
      "---",
      "More Rules...",
    ]);
  });

  it("Clear Rules: Excel's four rows; This Table and This PivotTable start disabled", () => {
    expect(shape(items.get("cf:clearRules")!.children)).toEqual([
      "Clear Rules from Selected Cells",
      "Clear Rules from Entire Sheet",
      "Clear Rules from This Table",
      "Clear Rules from This PivotTable",
    ]);
    expect(items.get("cf:clearFromTable")!.disabled).toBe(true);
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(true);
  });

  it("every row that runs something carries a picture or reserves the picture column", () => {
    const rows = [...items.values()].filter((it) => !it.separator);
    const bare = rows.filter((it) => it.icon === undefined || it.icon === null).map((it) => it.id);
    expect(bare).toEqual([]);
  });

  it("the cleanup takes back the separator and the item, and nothing else", () => {
    const unregister = vi.fn();
    const undo = registerCFMenuItems({
      ui: { menus: { registerItem: () => undefined, unregisterItem: unregister } },
    } as never);
    undo();
    expect(unregister.mock.calls).toEqual([
      ["format", "format:cf-separator"],
      ["format", "format:conditionalFormatting"],
    ]);
  });
});

// ============================================================================
// What the new rows open
// ============================================================================

describe("A Date Occurring... and the More Rules... rows", () => {
  const SELECTION = { startRow: 1, startCol: 1, endRow: 3, endCol: 2 };

  it("A Date Occurring... opens the quick dialog on the date rule", async () => {
    await items.get("cf:dateOccurring")!.action!();
    expect(h.showDialog).toHaveBeenCalledWith(QUICK_CF_DIALOG_ID, { ruleType: "dateOccurring", selection: SELECTION });
  });

  it("Highlight Cells Rules > More Rules... opens New Rule on 'Format only cells that contain'", async () => {
    await items.get("cf:highlightMoreRules")!.action!();
    expect(h.showDialog).toHaveBeenCalledWith(NEW_RULE_DIALOG_ID, {
      selection: SELECTION,
      initialCategory: "formatContaining",
    });
  });

  it("Top/Bottom Rules > More Rules... opens New Rule on 'top or bottom ranked values'", async () => {
    await items.get("cf:topBottomMoreRules")!.action!();
    expect(h.showDialog).toHaveBeenCalledWith(NEW_RULE_DIALOG_ID, {
      selection: SELECTION,
      initialCategory: "topBottom",
    });
  });

  it("each gallery's More Rules... opens New Rule on 'based on their values' with its own format style", async () => {
    const expected: Record<string, string> = { dataBars: "dataBar", colorScales: "colorScale", iconSets: "iconSet" };
    for (const [id, style] of Object.entries(expected)) {
      h.showDialog.mockReset();
      await openGallery(`cf:${id}`);
      act(() => h.gallery.get(id)!.onMoreRules());
      expect(h.showDialog, id).toHaveBeenCalledWith(NEW_RULE_DIALOG_ID, {
        selection: SELECTION,
        initialCategory: "formatByValues",
        initialFormatStyle: style,
      });
    }
  });

  it("New Rule... itself opens on Excel's first-shown category", async () => {
    await items.get("cf:newRule")!.action!();
    expect(h.showDialog).toHaveBeenCalledWith(NEW_RULE_DIALOG_ID, { selection: SELECTION });
  });
});

// ============================================================================
// The galleries write Excel's rules
// ============================================================================

describe("gallery picks", () => {
  it("Color Scales writes the picked preset's rule over the selection", async () => {
    await openGallery("cf:colorScales");
    await act(async () => {
      h.gallery.get("colorScales")!.onSelect({ label: "Green - Yellow - Red", minColor: "#F8696B", midColor: "#FFEB84", maxColor: "#63BE7B" });
    });
    await flush();
    expect(h.addConditionalFormat).toHaveBeenCalledWith({
      rule: {
        type: "colorScale",
        minPoint: { valueType: "min", color: "#F8696B" },
        midPoint: { valueType: "percentile", value: 50, color: "#FFEB84" },
        maxPoint: { valueType: "max", color: "#63BE7B" },
      },
      format: {},
      ranges: [{ startRow: 1, startCol: 1, endRow: 3, endCol: 2 }],
      stopIfTrue: false,
    }, { target: undefined });
    expect(h.invalidateAndRefresh).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// The backend says no
// ============================================================================

describe("a refusal from the backend is reported, never an unhandled rejection", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  async function settle(): Promise<void> {
    await flush();
    // Node reports an unhandled rejection after the microtask queue drains.
    await new Promise((r) => setTimeout(r, 0));
  }

  it("a gallery pick whose add THROWS shows one error toast and refreshes nothing", async () => {
    h.addConditionalFormat.mockRejectedValue(new Error("The sheet is protected."));
    await openGallery("cf:dataBars");
    act(() => h.gallery.get("dataBars")!.onSelect("#638EC6", true));
    await settle();
    expect(unhandled).toEqual([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
    expect(toasts[0].message).toContain("The sheet is protected.");
    expect(h.invalidateAndRefresh).not.toHaveBeenCalled();
  });

  it("a gallery pick the backend REFUSES (success: false) says why", async () => {
    h.addConditionalFormat.mockResolvedValue({ success: false, error: "Invalid range" });
    await openGallery("cf:iconSets");
    act(() => h.gallery.get("iconSets")!.onSelect("threeArrows", 3));
    await settle();
    expect(unhandled).toEqual([]);
    expect(toasts.map((t) => t.variant)).toEqual(["error"]);
    expect(toasts[0].message).toContain("Invalid range");
    expect(h.invalidateAndRefresh).not.toHaveBeenCalled();
  });

  it("a clear that THROWS shows one error toast", async () => {
    h.clearConditionalFormatsInRange.mockRejectedValue(new Error("backend gone"));
    await items.get("cf:clearFromSheet")!.action!();
    await settle();
    expect(unhandled).toEqual([]);
    expect(toasts.map((t) => t.variant)).toEqual(["error"]);
    expect(toasts[0].message).toContain("backend gone");
  });
});

// ============================================================================
// Clear Rules from Selected Cells reports a clear that cleared nothing
// ============================================================================

describe("Clear Rules from Selected Cells", () => {
  it("clears the selection and is quiet when it removed something", async () => {
    h.clearConditionalFormatsInRange.mockResolvedValue(2);
    await items.get("cf:clearFromSelection")!.action!();
    await flush();
    expect(h.clearConditionalFormatsInRange).toHaveBeenCalledWith(1, 1, 3, 2, undefined, { target: undefined });
    expect(toasts).toEqual([]);
    expect(h.invalidateAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("SAYS so when it removed nothing (the backend's count was dropped)", async () => {
    h.clearConditionalFormatsInRange.mockResolvedValue(0);
    await items.get("cf:clearFromSelection")!.action!();
    await flush();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("info");
    expect(toasts[0].message).toMatch(/no conditional formatting rule/i);
    expect(toasts[0].message).toMatch(/selected cells/i);
  });
});

// ============================================================================
// From This Table / This PivotTable
// ============================================================================

const SALES_TABLE = { id: "t1", name: "Sales", sheetIndex: 0, startRow: 0, startCol: 0, endRow: 9, endCol: 3 };
const PIVOT = { pivotId: 7, name: "PivotTable1", startRow: 20, startCol: 5, endRow: 30, endCol: 8, isEmpty: false };

describe("Clear Rules from This Table / This PivotTable follow the ACTIVE cell", () => {
  it("both stay disabled outside a table and a PivotTable", async () => {
    setMenuSelection({ startRow: 40, startCol: 0, endRow: 40, endCol: 0 });
    await refreshClearScopes();
    expect(items.get("cf:clearFromTable")!.disabled).toBe(true);
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(true);
  });

  it("inside a table, This Table enables -- and the menus hear about it", async () => {
    h.getTableAtCell.mockImplementation(async (row: number, col: number) =>
      row >= 0 && row <= 9 && col >= 0 && col <= 3 ? SALES_TABLE : null,
    );
    const heard = vi.fn();
    const unsubscribe = subscribeToMenus(heard);
    setMenuSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    await refreshClearScopes();
    unsubscribe();
    expect(h.getTableAtCell).toHaveBeenCalledWith(2, 1);
    expect(items.get("cf:clearFromTable")!.disabled).toBe(false);
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(true);
    expect(heard).toHaveBeenCalled();
  });

  it("uses the ACTIVE cell (the selection's end), not its top-left corner", async () => {
    h.getTableAtCell.mockImplementation(async (row: number) => (row === 5 ? SALES_TABLE : null));
    // Anchor at row 40, active cell at row 5 (selected upward).
    setMenuSelection({ startRow: 40, startCol: 0, endRow: 5, endCol: 0 });
    await refreshClearScopes();
    expect(items.get("cf:clearFromTable")!.disabled).toBe(false);
  });

  it("an unchanged answer does not re-render every menu", async () => {
    await refreshClearScopes();
    const heard = vi.fn();
    const unsubscribe = subscribeToMenus(heard);
    await refreshClearScopes();
    unsubscribe();
    expect(heard).not.toHaveBeenCalled();
  });

  it("This Table clears the table's whole range", async () => {
    h.getTableAtCell.mockResolvedValue(SALES_TABLE);
    setMenuSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    await refreshClearScopes();
    await items.get("cf:clearFromTable")!.action!();
    await flush();
    expect(h.clearConditionalFormatsInRange).toHaveBeenCalledWith(0, 0, 9, 3, undefined, { target: undefined });
    expect(h.invalidateAndRefresh).toHaveBeenCalledTimes(1);
  });

  it("inside a PivotTable, This PivotTable enables and clears the pivot's range", async () => {
    h.getPivotRegionsForSheet.mockResolvedValue([PIVOT]);
    setMenuSelection({ startRow: 25, startCol: 6, endRow: 25, endCol: 6 });
    await refreshClearScopes();
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(false);
    expect(items.get("cf:clearFromTable")!.disabled).toBe(true);
    await items.get("cf:clearFromPivot")!.action!();
    await flush();
    expect(h.clearConditionalFormatsInRange).toHaveBeenCalledWith(20, 5, 30, 8, undefined, { target: undefined });
  });

  it("a pivot drawn on a canvas sheet is not a grid range the active cell can be in", async () => {
    h.getPivotRegionsForSheet.mockResolvedValue([{ ...PIVOT, canvasFrame: { x: 0, y: 0, width: 100, height: 100 } }]);
    setMenuSelection({ startRow: 25, startCol: 6, endRow: 25, endCol: 6 });
    await refreshClearScopes();
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(true);
  });

  it("a stale answer never overwrites a newer one", async () => {
    let releaseFirst: (t: unknown) => void = () => {};
    h.getTableAtCell
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockResolvedValueOnce(null);
    setMenuSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    const first = refreshClearScopes();
    setMenuSelection({ startRow: 40, startCol: 1, endRow: 40, endCol: 1 });
    await refreshClearScopes();
    releaseFirst(SALES_TABLE);
    await first;
    expect(items.get("cf:clearFromTable")!.disabled).toBe(true);
  });

  it("a lookup that fails leaves both disabled and throws nothing", async () => {
    h.getTableAtCell.mockRejectedValue(new Error("no backend"));
    h.getPivotRegionsForSheet.mockRejectedValue(new Error("no backend"));
    await expect(refreshClearScopes()).resolves.toBeUndefined();
    expect(items.get("cf:clearFromTable")!.disabled).toBe(true);
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(true);
  });

  it("clicked after the table went away: re-resolved at the click, nothing cleared, and it says why", async () => {
    h.getTableAtCell.mockResolvedValueOnce(SALES_TABLE).mockResolvedValue(null);
    setMenuSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
    await refreshClearScopes();
    await items.get("cf:clearFromTable")!.action!();
    await flush();
    expect(h.clearConditionalFormatsInRange).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/not in a table/i);
  });
});
