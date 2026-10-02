//! FILENAME: app/extensions/BuiltIn/HomeTab/components/MergeSplitButton.tsx
// PURPOSE: Excel's Merge & Center split button for the Home tab's Alignment
//          group: the icon half runs Merge & Center, the chevron opens Excel's
//          Merge menu (Merge & Center, Merge Across, Merge Cells, Unmerge Cells).
// CONTEXT: Rendered for the catalog item "mergeCells" (its id is persisted in
//          customised layouts and never changes). Built on @api/layout's
//          SplitMenuButton, so the menu has the full popup keyboard model.
//
//          PRESSED, like Excel's: whenever ANY merged cell lies in the selection
//          -- the active cell need not be merged -- the button shows pressed and
//          clicking it unmerges (core.grid.mergeCenter decides; this only draws
//          the state). DISABLED, like Excel's, on a protected sheet, while a cell
//          is being edited, and when the selection touches a table; the tooltip
//          then says why.
//
//          The reads live HERE, not in useHomeTabState: that hook runs once per
//          Home group (seven of them), and only the group that shows this button
//          should pay for the merge and protection reads on every selection
//          change.

import React, { useEffect, useMemo, useState } from "react";
import { useGridState } from "@api/grid";
import { CoreCommands } from "@api/commands";
import { isSheetProtected, readSelectionMergeState } from "@api/lib";
import { getGridRegions, onRegionChange, type GridRegion } from "@api/gridOverlays";
import { SplitMenuButton, MenuItem, ICON_SIZE_SM } from "@api/layout";
import type { Selection } from "@api/types";
import type { HomeTabItem } from "../homeTabConfig";
import { homeTabIcon, mergeMenuIcon, type MergeMenuCommand } from "./homeTabIcons";
import { itemTooltip } from "./itemTooltip";

/** Why the control is disabled, as the tooltip says it. */
export const MERGE_UNAVAILABLE = {
  protectedSheet: "Merge & Center isn't available on a protected sheet.",
  editing: "Finish editing the cell to merge or unmerge.",
  table: "Cells in a table can't be merged. Convert the table to a range first.",
} as const;

/** The rows of Excel's Merge menu, in its order, with its words. */
export const MERGE_MENU_LABELS: Readonly<Record<MergeMenuCommand, string>> = {
  mergeCenter: "Merge & Center",
  mergeAcross: "Merge Across",
  mergeCells: "Merge Cells",
  unmergeCells: "Unmerge Cells",
};

/** Menu row icons are drawn on the 20px grid. */
const MENU_ICON_SIZE = 20;

/** Events after which the document under an unmoved selection may differ:
 *  a merge or another out-of-band write (`grid:refresh`), another sheet,
 *  Protect/Unprotect Sheet, and an UNDO or REDO (`app:mutation-refresh`,
 *  AppEvents.MUTATION_REFRESH). The undo door dispatches no grid:refresh, and
 *  undoing a merge over empty cells records no cell change, so it re-selects
 *  nothing either: MUTATION_REFRESH is the only thing it announces. Without it
 *  the button stayed pressed over a merge Ctrl+Z had just removed. */
const REVISION_EVENTS = ["grid:refresh", "app:sheet-changed", "protection:refresh", "app:mutation-refresh"] as const;

/** Whether two rectangles share a cell. */
function overlaps(
  a: { startRow: number; startCol: number; endRow: number; endCol: number },
  b: { startRow: number; startCol: number; endRow: number; endCol: number },
): boolean {
  const aTop = Math.min(a.startRow, a.endRow);
  const aBottom = Math.max(a.startRow, a.endRow);
  const aLeft = Math.min(a.startCol, a.endCol);
  const aRight = Math.max(a.startCol, a.endCol);
  return !(aBottom < b.startRow || aTop > b.endRow || aRight < b.startCol || aLeft > b.endCol);
}

/** Whether any block of the selection touches a table on this sheet (Excel
 *  disables every Merge command then, even for half a table). */
export function selectionTouchesTable(selection: Selection | null, regions: GridRegion[]): boolean {
  if (!selection) return false;
  const tables = regions.filter((r) => r.type === "table");
  if (tables.length === 0) return false;
  const blocks = [selection, ...(selection.additionalRanges ?? [])];
  return blocks.some((b) => tables.some((t) => overlaps(b, t)));
}

function currentRegions(): GridRegion[] {
  try {
    return getGridRegions() ?? [];
  } catch {
    return [];
  }
}

export interface MergeSplitButtonProps {
  /** The catalog item ("mergeCells"). */
  item: HomeTabItem;
  /** The icon half: runs the item (Merge & Center). */
  onRun: () => void;
  /** A row of the menu. */
  onCommand: (command: MergeMenuCommand) => void;
}

export function MergeSplitButton({ item, onRun, onCommand }: MergeSplitButtonProps): React.ReactElement {
  const gridState = useGridState();
  const selection = gridState.selection;
  const editing = gridState.editing !== null && gridState.editing !== undefined;

  const [pressed, setPressed] = useState(false);
  const [protectedSheet, setProtectedSheet] = useState(false);
  const [revision, setRevision] = useState(0);
  const [regionsRevision, setRegionsRevision] = useState(0);

  // Coalesced, like the ribbon's style read: one re-read per quiet 120 ms.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRevision((n) => n + 1), 120);
    };
    for (const name of REVISION_EVENTS) window.addEventListener(name, bump);
    return () => {
      if (timer) clearTimeout(timer);
      for (const name of REVISION_EVENTS) window.removeEventListener(name, bump);
    };
  }, []);

  useEffect(() => {
    try {
      return onRegionChange(() => setRegionsRevision((n) => n + 1));
    } catch {
      return undefined;
    }
  }, []);

  // The two backend reads. Started inside a resolved promise so a failure of
  // any kind -- an IPC error, a test double without the export -- lands in the
  // catch and reads as "not pressed" / "not protected" rather than throwing
  // out of an effect.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => readSelectionMergeState(selection))
      .then((state) => {
        if (!cancelled) setPressed(state?.touchesMerge === true);
      })
      .catch(() => {
        if (!cancelled) setPressed(false);
      });
    Promise.resolve()
      .then(() => isSheetProtected())
      .then((isProtected) => {
        if (!cancelled) setProtectedSheet(isProtected === true);
      })
      .catch(() => {
        if (!cancelled) setProtectedSheet(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection, revision]);

  const inTable = useMemo(
    () => selectionTouchesTable(selection, currentRegions()),
    // regionsRevision: a table created or removed under an unmoved selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, regionsRevision],
  );

  const unavailable: string | null = protectedSheet
    ? MERGE_UNAVAILABLE.protectedSheet
    : editing
      ? MERGE_UNAVAILABLE.editing
      : inTable
        ? MERGE_UNAVAILABLE.table
        : null;

  const tip = itemTooltip(item);
  const row = (command: MergeMenuCommand) => mergeMenuIcon(command, MENU_ICON_SIZE);

  return (
    <SplitMenuButton
      icon={homeTabIcon(item.id, ICON_SIZE_SM)}
      label={item.label}
      pressed={pressed}
      tooltip={unavailable ?? tip.tooltip}
      shortcut={unavailable ? undefined : tip.shortcut}
      commandId={unavailable ? undefined : tip.commandId}
      data-testid={`fmt-${item.id}`}
      data-active={pressed || undefined}
      disabled={unavailable !== null}
      onClick={onRun}
      chevronLabel="Merge options"
      chevronTestId={`fmt-${item.id}-options`}
      menuLabel="Merge"
    >
      <MenuItem
        role="menuitemcheckbox"
        checked={pressed}
        icon={row("mergeCenter")}
        testId="fmt-merge-center"
        onSelect={() => onCommand("mergeCenter")}
      >
        {MERGE_MENU_LABELS.mergeCenter}
      </MenuItem>
      <MenuItem icon={row("mergeAcross")} testId="fmt-merge-across" onSelect={() => onCommand("mergeAcross")}>
        {MERGE_MENU_LABELS.mergeAcross}
      </MenuItem>
      <MenuItem
        icon={row("mergeCells")}
        testId="fmt-merge-cells"
        // Ctrl+M (Calcula's; Excel has no merge shortcut) runs Merge Cells:
        // its live binding is shown here, where it can be discovered.
        shortcutCommandId={CoreCommands.MERGE_CELLS}
        onSelect={() => onCommand("mergeCells")}
      >
        {MERGE_MENU_LABELS.mergeCells}
      </MenuItem>
      <MenuItem icon={row("unmergeCells")} testId="fmt-merge-unmerge" onSelect={() => onCommand("unmergeCells")}>
        {MERGE_MENU_LABELS.unmergeCells}
      </MenuItem>
    </SplitMenuButton>
  );
}
