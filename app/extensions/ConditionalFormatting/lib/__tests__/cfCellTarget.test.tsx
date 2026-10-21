//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfCellTarget.test.tsx
// PURPOSE: Conditional Formatting on a floating grid's cells (P3 S11, owner
//          finding G3): every row that acts on the selection asks
//          resolveCellTarget(action, "conditionalFormat"); on the grid's cells
//          the rule is built over the OBJECT's selection and written with its
//          target (never Core's hidden selection, never the sheet's rules
//          cache); the dialogs open with the target; Clear Rules from Selected
//          Cells clears with it; Manage Rules lists the object's rules and says
//          "This floating grid (Float1)"; the table / PivotTable rows stay
//          disabled (an object holds neither). An owner that admits no
//          "conditionalFormat" refuses with nothing written (inert until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  addConditionalFormat: vi.fn(),
  clearConditionalFormatsInRange: vi.fn(),
  getAllConditionalFormats: vi.fn(),
  deleteConditionalFormat: vi.fn(),
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
  getAllConditionalFormats: (...a: unknown[]) => h.getAllConditionalFormats(...a),
  deleteConditionalFormat: (...a: unknown[]) => h.deleteConditionalFormat(...a),
  restoreFocusToGrid: () => {},
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getTableAtCell: (...a: unknown[]) => h.getTableAtCell(...a),
  getPivotRegionsForSheet: (...a: unknown[]) => h.getPivotRegionsForSheet(...a),
}));
vi.mock("../cfStore", () => ({ invalidateAndRefresh: () => h.invalidateAndRefresh(), getRules: () => [] }));
vi.mock("../../components/ColorScaleGallery", () => ({ ColorScaleGallery: h.capture("colorScales") }));
vi.mock("../../components/DataBarGallery", () => ({ DataBarGallery: h.capture("dataBars") }));
vi.mock("../../components/IconSetGallery", () => ({ IconSetGallery: h.capture("iconSets") }));

import {
  registerCFMenuItems,
  setMenuSelection,
  refreshClearScopes,
  QUICK_CF_DIALOG_ID,
  NEW_RULE_DIALOG_ID,
  RULES_MANAGER_DIALOG_ID,
} from "../../handlers/homeMenuBuilder";
import { RulesManagerDialog } from "../../components/RulesManagerDialog";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

interface Item {
  id: string;
  label: string;
  separator?: boolean;
  disabled?: boolean;
  action?: () => unknown;
  customContent?: (close: () => void) => React.ReactElement;
  children?: Item[];
}

const REF = { kind: "floatingRange" as const, id: "fr-1" };
/** The object's selection B3:C5 (anchor C5, active B3). */
const FR_SEL: Selection = { startRow: 4, startCol: 2, endRow: 2, endCol: 1, type: "cells", activeRow: 2, activeCol: 1 };
const FR_RANGE = { startRow: 2, startCol: 1, endRow: 4, endCol: 2 };

const items = new Map<string, Item>();
const toasts: ToastPayload[] = [];
let container: HTMLDivElement;
let root: Root;
let cleanup: () => void = () => {};
let release: () => void = () => {};
let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["conditionalFormat"];

function collect(item: Item): void {
  items.set(item.id, item);
  for (const child of item.children ?? []) collect(child);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  for (const fn of [
    h.addConditionalFormat,
    h.clearConditionalFormatsInRange,
    h.getAllConditionalFormats,
    h.deleteConditionalFormat,
    h.showDialog,
    h.getTableAtCell,
    h.getPivotRegionsForSheet,
  ]) {
    fn.mockReset();
  }
  h.invalidateAndRefresh.mockClear();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  h.clearConditionalFormatsInRange.mockResolvedValue(1);
  h.getAllConditionalFormats.mockResolvedValue([]);
  h.deleteConditionalFormat.mockResolvedValue({ success: true });
  // Core's hidden active cell sits in a table: the object must not say so.
  h.getTableAtCell.mockResolvedValue({ startRow: 0, startCol: 0, endRow: 9, endCol: 3 });
  h.getPivotRegionsForSheet.mockResolvedValue([]);
  h.gallery.clear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  items.clear();
  actsOn = ["conditionalFormat"];
  frSelection = FR_SEL;
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    get actsOn() {
      return actsOn;
    },
    refusal: (action) => `${action} is not available inside a floating grid yet. Nothing was changed.`,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 10, cols: 5 }, label: "Float1", wholeObject: false },
  });
  cleanup = registerCFMenuItems({
    ui: { menus: { registerItem: (_m: string, item: Item) => collect(item), unregisterItem: () => undefined } },
  } as never);
  // Core's own (hidden) selection: far from the object's.
  setMenuSelection({ startRow: 40, startCol: 40, endRow: 41, endCol: 41 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  cleanup();
  release();
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Conditional Formatting on a floating grid's cells", () => {
  it("a gallery pick writes the rule over the OBJECT's selection with its target", async () => {
    await act(async () => {
      root.render(items.get("cf:colorScales")!.customContent!(() => {}));
    });
    await act(async () => {
      h.gallery.get("colorScales")!.onSelect({ label: "G-Y-R", minColor: "#F8696B", midColor: "#FFEB84", maxColor: "#63BE7B" });
    });
    await flush();
    expect(h.addConditionalFormat).toHaveBeenCalledTimes(1);
    const [params, placement] = h.addConditionalFormat.mock.calls[0];
    expect(params.ranges).toEqual([FR_RANGE]);
    expect(placement).toEqual({ target: REF });
    // The object re-reads its own CF; the sheet's rules cache is not the object's.
    expect(h.invalidateAndRefresh).not.toHaveBeenCalled();
  });

  it("the quick and New Rule dialogs open with the object's range and target", () => {
    items.get("cf:greaterThan")!.action!();
    items.get("cf:newRule")!.action!();
    expect(h.showDialog).toHaveBeenNthCalledWith(1, QUICK_CF_DIALOG_ID, {
      ruleType: "greaterThan",
      selection: FR_RANGE,
      target: REF,
    });
    expect(h.showDialog).toHaveBeenNthCalledWith(2, NEW_RULE_DIALOG_ID, { selection: FR_RANGE, target: REF });
  });

  it("Clear Rules from Selected Cells clears the object's range with its target", async () => {
    items.get("cf:clearFromSelection")!.action!();
    await flush();
    expect(h.clearConditionalFormatsInRange).toHaveBeenCalledWith(2, 1, 4, 2, undefined, { target: REF });
  });

  it("the table / PivotTable rows stay disabled: Core's hidden active cell is not asked", async () => {
    await refreshClearScopes();
    await flush();
    expect(h.getTableAtCell).not.toHaveBeenCalled();
    expect(items.get("cf:clearFromTable")!.disabled).toBe(true);
    expect(items.get("cf:clearFromPivot")!.disabled).toBe(true);
  });

  it("Manage Rules opens on the object's rules and names the scope", async () => {
    items.get("cf:manageRules")!.action!();
    expect(h.showDialog).toHaveBeenCalledWith(RULES_MANAGER_DIALOG_ID, {
      target: REF,
      scopeLabel: "This floating grid (Float1)",
    });
    const data = h.showDialog.mock.calls[0][1] as Record<string, unknown>;
    h.getAllConditionalFormats.mockResolvedValue([
      {
        id: 7,
        rule: { type: "blankCells" },
        format: {},
        ranges: [FR_RANGE],
        stopIfTrue: false,
        enabled: true,
        priority: 1,
      },
    ]);
    await act(async () => {
      root.render(<RulesManagerDialog isOpen onClose={() => {}} data={data} />);
    });
    await flush();
    expect(h.getAllConditionalFormats).toHaveBeenCalledWith(undefined, { target: REF });
    expect(container.querySelector("[data-cf-rules-scope]")?.textContent).toBe(
      "Showing formatting rules for: This floating grid (Float1)",
    );
    expect(container.textContent).toContain("Blank Cells");
  });

  it("inert until the owner admits \"conditionalFormat\": refused once, nothing written or opened", async () => {
    actsOn = [];
    items.get("cf:greaterThan")!.action!();
    items.get("cf:clearFromSelection")!.action!();
    await flush();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(h.clearConditionalFormatsInRange).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message)).toEqual([
      "Conditional Formatting is not available inside a floating grid yet. Nothing was changed.",
      "Clear Rules is not available inside a floating grid yet. Nothing was changed.",
    ]);
  });
});
