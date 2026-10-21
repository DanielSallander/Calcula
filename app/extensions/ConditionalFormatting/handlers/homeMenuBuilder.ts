//! FILENAME: app/extensions/ConditionalFormatting/handlers/homeMenuBuilder.ts
// PURPOSE: Registers the Conditional Formatting tree in the Format menu -- the
//          ONE tree the menu bar and the Home tab's Conditional Formatting hero
//          both show.
// CONTEXT: The Home tab may not import this extension (the Facade and Seam
//          rules), so its hero hosts menu "format" > item
//          "format:conditionalFormatting" through the kit's registered-menu
//          seam (RegisteredMenuButton, @api/layout): children become submenus,
//          a child's customContent becomes a gallery flyout, `disabled` and
//          `icon` are honoured. Whatever is registered here is therefore what
//          BOTH doors show -- change it here, never copy it.
//
//          The tree is Excel's, read from live Excel 16 (M365) on 2026-10-04
//          over UI Automation (scratchpad styles-probe/cfprobe.ps1):
//
//            Highlight Cells Rules >   Greater Than... Less Than... Between...
//                                      Equal To... Text that Contains...
//                                      A Date Occurring... Duplicate Values...
//                                      --- More Rules...
//            Top/Bottom Rules >        Top 10 Items... Top 10 %... Bottom 10
//                                      Items... Bottom 10 %... Above Average...
//                                      Below Average... --- More Rules...
//            ---
//            Data Bars > (gallery)     Color Scales > (gallery)
//            Icon Sets > (gallery)
//            ---
//            New Rule...
//            Clear Rules >             from Selected Cells / Entire Sheet /
//                                      This Table / This PivotTable
//            Manage Rules...
//
//          "This Table" and "This PivotTable" are DISABLED unless the active
//          cell is in one, as in Excel. A registered item's `disabled` is read
//          when a menu renders, so it is kept current: index.ts calls
//          refreshClearScopes() as the selection, the sheet, the tables or the
//          pivots change, which resolves the active cell's table/pivot through
//          @api/backend and patches the two items in place (the registry's
//          documented "mutate, then notifyMenusChanged()" -- updateMenuItem
//          reaches top-level items only). The click resolves again, so a stale
//          state can never clear the wrong range.
//
//          Every write goes through lib/ruleWrites.ts: a backend refusal is a
//          toast, never an unhandled promise rejection.
//
//          P3 (owner finding G3): every item that acts on the selection asks
//          resolveCellTarget(action, "conditionalFormat"). On a floating
//          grid's cells the rule is built over the OBJECT's selection and
//          written with its target; the dialogs are opened with that target;
//          Manage Rules lists the object's rules ("This floating grid
//          (Float1)"). An object holds no table or PivotTable, so the two
//          region rows stay disabled there.

import React from "react";
import type { ExtensionContext } from "@api/contract";
import {
  showDialog,
  showToast,
  notifyMenusChanged,
  IconConditionalFormatting,
  IconHighlightCells,
  IconGreaterThan,
  IconLessThan,
  IconBetween,
  IconEqualTo,
  IconTextContains,
  IconDuplicateValues,
  IconTopBottom,
  IconTop10,
  IconTopPercent,
  IconBottom10,
  IconBottomPercent,
  IconAboveAverage,
  IconBelowAverage,
  IconColorScales,
  IconDataBars,
  IconIconSets,
  IconNewRule,
  IconClear,
  IconManageRules,
} from "@api";
import type {
  ConditionalFormatRule,
  ConditionalFormat,
  ConditionalFormatRange,
  IconSetType,
} from "@api";
import type { MenuItemDefinition } from "@api/uiTypes";
import type { PivotRegionData } from "@api/pivot";
import { getTableAtCell, getPivotRegionsForSheet } from "@api/backend";
import { MENU_ICON_BLANK } from "@api/layout";
import {
  resolveCellTarget,
  cellTargetFor,
  onCellTargetChanged,
  targetRefOf,
  type CellTarget,
  type CellTargetRef,
} from "@api/cellTarget";
import { addRuleReporting, clearRulesReporting } from "../lib/ruleWrites";
import { colorScaleRule, dataBarRule, iconSetRule } from "../lib/presetRules";
import type { PresetColorScale, NewRuleCategory, NewRuleFormatStyle } from "../types";
import { ColorScaleGallery } from "../components/ColorScaleGallery";
import { DataBarGallery } from "../components/DataBarGallery";
import { IconSetGallery } from "../components/IconSetGallery";
import { IconDateOccurring } from "../components/cfGlyphs";

export const QUICK_CF_DIALOG_ID = "cf-quick-dialog";
export const RULES_MANAGER_DIALOG_ID = "cf-rules-manager";
export const NEW_RULE_DIALOG_ID = "cf-new-rule-dialog";

// ============================================================================
// The selection these items act on
// ============================================================================

// Module-level selection cache (updated by index.ts via onSelectionChange).
// startRow/startCol is the ANCHOR and endRow/endCol the ACTIVE cell, as in
// Core's Selection -- not yet normalised, so the active cell survives.
let currentSelection: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null = null;

/** Update the cached selection (called from index.ts) */
export function setMenuSelection(sel: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null): void {
  currentSelection = sel;
}

/** Get the current selection as a CF range */
function getSelectionRange(): ConditionalFormatRange | null {
  if (!currentSelection) return null;
  const minRow = Math.min(currentSelection.startRow, currentSelection.endRow);
  const maxRow = Math.max(currentSelection.startRow, currentSelection.endRow);
  const minCol = Math.min(currentSelection.startCol, currentSelection.endCol);
  const maxCol = Math.max(currentSelection.startCol, currentSelection.endCol);
  return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol };
}

/** The active cell: what Excel's "This Table" / "This PivotTable" ask about. */
function activeCell(): { row: number; col: number } | null {
  if (!currentSelection) return null;
  return { row: currentSelection.endRow, col: currentSelection.endCol };
}

/**
 * The cells these items act on: Core's selection, or a floating grid's own
 * (P3). Any other owner of the selection (BUG-0185: Core's selection HIDDEN
 * under it) refuses -- once -- and the item does nothing. Manage Rules and
 * Clear Rules from Entire Sheet are not about the selection.
 */
interface CFPlace {
  /** The rule's range: the object's selection, or Core's (from the cache). */
  range: ConditionalFormatRange | null;
  /** The object's target; undefined for the active sheet. */
  target: CellTargetRef | undefined;
}

function rangeOf(sel: { startRow: number; startCol: number; endRow: number; endCol: number }): ConditionalFormatRange {
  return {
    startRow: Math.min(sel.startRow, sel.endRow),
    startCol: Math.min(sel.startCol, sel.endCol),
    endRow: Math.max(sel.startRow, sel.endRow),
    endCol: Math.max(sel.startCol, sel.endCol),
  };
}

function placeOf(t: CellTarget): CFPlace {
  if (t.kind === "object") return { range: rangeOf(t.selection), target: t.ref };
  return { range: getSelectionRange(), target: undefined };
}

/** Ask the door's question; null = refused (announced once). */
function placeFor(action: string): CFPlace | null {
  const t = resolveCellTarget(action, "conditionalFormat");
  return t === null ? null : placeOf(t);
}

/** Whether a floating grid's cells (an object target) hold the selection now. */
function objectHoldsSelection(): boolean {
  const t = cellTargetFor("conditionalFormat", "Conditional Formatting");
  return "kind" in t && t.kind === "object";
}

// ============================================================================
// Actions
// ============================================================================

/** Add a quick rule with the current selection and given rule + format. Never
 *  rejects: a gallery pick calls it fire-and-forget. */
async function addQuickRule(
  rule: ConditionalFormatRule,
  format: ConditionalFormat
): Promise<void> {
  const place = placeFor("Conditional Formatting");
  if (!place?.range) return;
  await addRuleReporting(
    {
      rule,
      format,
      ranges: [place.range],
      stopIfTrue: false,
    },
    place.target,
  );
}

/** Show a quick dialog for threshold-based rules */
function showQuickDialog(ruleType: string): void {
  const place = placeFor("Conditional Formatting");
  if (!place) return;
  showDialog(QUICK_CF_DIALOG_ID, {
    ruleType,
    selection: place.range,
    ...(place.target ? { target: place.target } : {}),
  });
}

/** Open New Rule, seeded with the current selection, on the page the door
 *  asks for (Excel's: see NewRuleDialogData in ../types.ts). */
function showNewRuleDialog(start?: {
  initialCategory: NewRuleCategory;
  initialFormatStyle?: NewRuleFormatStyle;
}): void {
  const place = placeFor("New Rule");
  if (!place) return;
  showDialog(NEW_RULE_DIALOG_ID, {
    selection: place.range,
    ...(place.target ? { target: place.target } : {}),
    ...(start ?? {}),
  });
}

/** Clear rules from the current selection -- and say so when nothing went. */
async function handleClearRulesFromSelection(): Promise<void> {
  const place = placeFor("Clear Rules");
  if (!place?.range) return;
  const removed = await clearRulesReporting(place.range, place.target);
  if (removed === 0) {
    showToast("Clear Rules: no conditional formatting rule was cleared from the selected cells.", {
      variant: "info",
    });
  }
}

/**
 * Manage Rules...: the rules of the place the selection is in -- a floating
 * grid's own ("This floating grid (Float1)") while one of its cells is
 * selected, else the active sheet's. Asked silently: Manage Rules is not about
 * the selection's cells, so another owner of the selection does not refuse it.
 */
export function showRulesManager(): void {
  const t = cellTargetFor("conditionalFormat", "Manage Rules");
  if ("kind" in t && t.kind === "object") {
    showDialog(RULES_MANAGER_DIALOG_ID, {
      target: targetRefOf(t),
      scopeLabel: `This floating grid (${t.label})`,
    });
    return;
  }
  showDialog(RULES_MANAGER_DIALOG_ID);
}

/** Clear all rules from the entire sheet */
async function handleClearAllRules(): Promise<void> {
  await clearRulesReporting({ startRow: 0, startCol: 0, endRow: 999999, endCol: 999999 });
}

// ============================================================================
// This Table / This PivotTable
// ============================================================================

/** The item objects as registered; patched in place by refreshClearScopes. */
let clearFromTableItem: MenuItemDefinition | null = null;
let clearFromPivotItem: MenuItemDefinition | null = null;
/** Bumped by every refresh: only the newest one may write its answer. */
let scopeGeneration = 0;

/** A lookup's answer, or null when it failed (logged): a failed lookup is
 *  "not in one", which leaves the row disabled -- never a thrown refresh. */
async function settled<T>(lookup: Promise<T>): Promise<T | null> {
  try {
    return await lookup;
  } catch (err) {
    console.warn("[ConditionalFormatting] table/pivot lookup failed:", err);
    return null;
  }
}

/** The range of the table the cell is in (the backend's answer), or null. */
async function tableRangeAt(row: number, col: number): Promise<ConditionalFormatRange | null> {
  const table = await getTableAtCell(row, col);
  if (!table) return null;
  return { startRow: table.startRow, startCol: table.startCol, endRow: table.endRow, endCol: table.endCol };
}

/** The range of the PivotTable the cell is in, or null. A pivot drawn on a
 *  canvas sheet (canvasFrame) occupies no grid cells, so no cell is "in" it. */
async function pivotRangeAt(row: number, col: number): Promise<ConditionalFormatRange | null> {
  const regions = (await getPivotRegionsForSheet<PivotRegionData>()) ?? [];
  const hit = regions.find(
    (r) =>
      !r.canvasFrame &&
      row >= r.startRow &&
      row <= r.endRow &&
      col >= r.startCol &&
      col <= r.endCol,
  );
  if (!hit) return null;
  return { startRow: hit.startRow, startCol: hit.startCol, endRow: hit.endRow, endCol: hit.endCol };
}

/**
 * Re-derive whether "Clear Rules from This Table" / "from This PivotTable" are
 * enabled for the active cell, and tell the menus only when that changed (a
 * notification re-renders every menu host). Never rejects; a slower, older
 * call can never overwrite a newer answer.
 */
export async function refreshClearScopes(): Promise<void> {
  const generation = ++scopeGeneration;
  // A floating grid's cells hold the selection: Core's active cell is HIDDEN
  // under the object, and the object holds no table or PivotTable.
  const cell = objectHoldsSelection() ? null : activeCell();
  let inTable = false;
  let inPivot = false;
  if (cell) {
    const [table, pivot] = await Promise.all([
      settled(tableRangeAt(cell.row, cell.col)),
      settled(pivotRangeAt(cell.row, cell.col)),
    ]);
    inTable = table !== null;
    inPivot = pivot !== null;
  }
  if (generation !== scopeGeneration) return;

  let changed = false;
  if (clearFromTableItem && clearFromTableItem.disabled !== !inTable) {
    clearFromTableItem.disabled = !inTable;
    changed = true;
  }
  if (clearFromPivotItem && clearFromPivotItem.disabled !== !inPivot) {
    clearFromPivotItem.disabled = !inPivot;
    changed = true;
  }
  if (changed) notifyMenusChanged();
}

/**
 * Clear the rules of the table / PivotTable at the active cell. The region is
 * resolved AGAIN at the click (the row's enabled state may be a moment old),
 * and a cell that is no longer in one clears nothing and says why.
 */
async function handleClearRulesFromRegion(kind: "table" | "pivot"): Promise<void> {
  const place = placeFor("Clear Rules");
  if (!place) return;
  const what = kind === "table" ? "a table" : "a PivotTable";
  const which = kind === "table" ? "this table" : "this PivotTable";
  if (place.target) {
    // A floating grid's cells: the object holds no table or PivotTable.
    showToast(`Clear Rules: the active cell is not in ${what}.`, { variant: "info" });
    void refreshClearScopes();
    return;
  }
  const cell = activeCell();
  if (!cell) return;
  const range = await settled(kind === "table" ? tableRangeAt(cell.row, cell.col) : pivotRangeAt(cell.row, cell.col));
  if (!range) {
    showToast(`Clear Rules: the active cell is not in ${what}.`, { variant: "info" });
    void refreshClearScopes();
    return;
  }
  const removed = await clearRulesReporting(range);
  if (removed === 0) {
    showToast(`Clear Rules: no conditional formatting rule was cleared from ${which}.`, { variant: "info" });
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register Conditional Formatting menu items into the Format menu.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items (the submenu's children go with it), never the Format menu, which
 * Standard Menus builds and Format Cells and others add to (wave E, Y14).
 */
export function registerCFMenuItems(context: ExtensionContext): () => void {
  // The two rows whose enabled state follows the active cell. Disabled until
  // the first refresh says the cell is in one (Excel's state on a plain cell).
  const clearFromTable: MenuItemDefinition = {
    id: "cf:clearFromTable",
    label: "Clear Rules from This Table",
    icon: IconClear,
    disabled: true,
    action: () => void handleClearRulesFromRegion("table"),
  };
  const clearFromPivot: MenuItemDefinition = {
    id: "cf:clearFromPivot",
    label: "Clear Rules from This PivotTable",
    icon: IconClear,
    disabled: true,
    action: () => void handleClearRulesFromRegion("pivot"),
  };
  clearFromTableItem = clearFromTable;
  clearFromPivotItem = clearFromPivot;

  // Separator before CF items
  context.ui.menus.registerItem("format", {
    id: "format:cf-separator",
    label: "",
    separator: true,
  });

  // Main Conditional Formatting menu with submenus
  context.ui.menus.registerItem("format", {
    id: "format:conditionalFormatting",
    label: "Conditional Formatting",
    icon: IconConditionalFormatting,
    children: [
      // ---- Highlight Cells Rules ----
      {
        id: "cf:highlightCells",
        label: "Highlight Cells Rules",
        icon: IconHighlightCells,
        children: [
          {
            id: "cf:greaterThan",
            label: "Greater Than...",
            icon: IconGreaterThan,
            action: () => showQuickDialog("greaterThan"),
          },
          {
            id: "cf:lessThan",
            label: "Less Than...",
            icon: IconLessThan,
            action: () => showQuickDialog("lessThan"),
          },
          {
            id: "cf:between",
            label: "Between...",
            icon: IconBetween,
            action: () => showQuickDialog("between"),
          },
          {
            id: "cf:equalTo",
            label: "Equal To...",
            icon: IconEqualTo,
            action: () => showQuickDialog("equalTo"),
          },
          {
            id: "cf:textContains",
            label: "Text that Contains...",
            icon: IconTextContains,
            action: () => showQuickDialog("textContains"),
          },
          {
            id: "cf:dateOccurring",
            label: "A Date Occurring...",
            icon: IconDateOccurring,
            action: () => showQuickDialog("dateOccurring"),
          },
          {
            // Excel has no "Unique Values..." row: Duplicate Values' own
            // dialog offers Duplicate / Unique, and so does Calcula's.
            id: "cf:duplicateValues",
            label: "Duplicate Values...",
            icon: IconDuplicateValues,
            action: () => showQuickDialog("duplicateValues"),
          },
          { id: "cf:separator-highlight-more", label: "", separator: true },
          {
            id: "cf:highlightMoreRules",
            label: "More Rules...",
            icon: MENU_ICON_BLANK,
            action: () => showNewRuleDialog({ initialCategory: "formatContaining" }),
          },
        ],
      },

      // ---- Top/Bottom Rules ----
      {
        id: "cf:topBottomRules",
        label: "Top/Bottom Rules",
        icon: IconTopBottom,
        children: [
          {
            id: "cf:top10Items",
            label: "Top 10 Items...",
            icon: IconTop10,
            action: () => showQuickDialog("top10Items"),
          },
          {
            id: "cf:top10Percent",
            label: "Top 10 %...",
            icon: IconTopPercent,
            action: () => showQuickDialog("top10Percent"),
          },
          {
            id: "cf:bottom10Items",
            label: "Bottom 10 Items...",
            icon: IconBottom10,
            action: () => showQuickDialog("bottom10Items"),
          },
          {
            id: "cf:bottom10Percent",
            label: "Bottom 10 %...",
            icon: IconBottomPercent,
            action: () => showQuickDialog("bottom10Percent"),
          },
          {
            id: "cf:aboveAverage",
            label: "Above Average...",
            icon: IconAboveAverage,
            action: () => showQuickDialog("aboveAverage"),
          },
          {
            id: "cf:belowAverage",
            label: "Below Average...",
            icon: IconBelowAverage,
            action: () => showQuickDialog("belowAverage"),
          },
          { id: "cf:separator-topbottom-more", label: "", separator: true },
          {
            id: "cf:topBottomMoreRules",
            label: "More Rules...",
            icon: MENU_ICON_BLANK,
            action: () => showNewRuleDialog({ initialCategory: "topBottom" }),
          },
        ],
      },

      // Excel draws a line between the rule submenus and the galleries.
      { id: "cf:separator-galleries", label: "", separator: true },

      // ---- Data Bars ----
      {
        id: "cf:dataBars",
        label: "Data Bars",
        icon: IconDataBars,
        customContent: (onClose) =>
          React.createElement(DataBarGallery, {
            onSelect: (color: string, gradientFill: boolean) => {
              void addQuickRule(dataBarRule(color, gradientFill), {});
            },
            onMoreRules: () =>
              showNewRuleDialog({ initialCategory: "formatByValues", initialFormatStyle: "dataBar" }),
            onClose,
          }),
      },

      // ---- Color Scales ----
      {
        id: "cf:colorScales",
        label: "Color Scales",
        icon: IconColorScales,
        customContent: (onClose) =>
          React.createElement(ColorScaleGallery, {
            onSelect: (preset: PresetColorScale) => {
              void addQuickRule(colorScaleRule(preset), {});
            },
            onMoreRules: () =>
              showNewRuleDialog({ initialCategory: "formatByValues", initialFormatStyle: "colorScale" }),
            onClose,
          }),
      },

      // ---- Icon Sets ----
      {
        id: "cf:iconSets",
        label: "Icon Sets",
        icon: IconIconSets,
        customContent: (onClose) =>
          React.createElement(IconSetGallery, {
            onSelect: (iconSetId: IconSetType, iconCount: number) => {
              void addQuickRule(iconSetRule(iconSetId, iconCount), {});
            },
            onMoreRules: () =>
              showNewRuleDialog({ initialCategory: "formatByValues", initialFormatStyle: "iconSet" }),
            onClose,
          }),
      },

      // ---- Separator ----
      { id: "cf:separator-mgmt", label: "", separator: true },

      // ---- New Rule ----
      {
        id: "cf:newRule",
        label: "New Rule...",
        icon: IconNewRule,
        action: () => showNewRuleDialog(),
      },

      // ---- Clear Rules ----
      {
        id: "cf:clearRules",
        label: "Clear Rules",
        icon: IconClear,
        children: [
          {
            id: "cf:clearFromSelection",
            label: "Clear Rules from Selected Cells",
            icon: IconClear,
            action: () => void handleClearRulesFromSelection(),
          },
          {
            id: "cf:clearFromSheet",
            label: "Clear Rules from Entire Sheet",
            icon: IconClear,
            action: () => void handleClearAllRules(),
          },
          clearFromTable,
          clearFromPivot,
        ],
      },

      // ---- Manage Rules ----
      {
        id: "cf:manageRules",
        label: "Manage Rules...",
        icon: IconManageRules,
        action: () => showRulesManager(),
      },
    ],
  });

  // A floating grid's selection moving changes what the region rows describe.
  const stopTargetWatch = onCellTargetChanged(() => void refreshClearScopes());

  return () => {
    stopTargetWatch();
    context.ui.menus.unregisterItem("format", "format:cf-separator");
    context.ui.menus.unregisterItem("format", "format:conditionalFormatting");
    if (clearFromTableItem === clearFromTable) clearFromTableItem = null;
    if (clearFromPivotItem === clearFromPivot) clearFromPivotItem = null;
  };
}
