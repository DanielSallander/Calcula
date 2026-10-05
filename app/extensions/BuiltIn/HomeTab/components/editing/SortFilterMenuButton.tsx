//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/SortFilterMenuButton.tsx
// PURPOSE: Excel's Sort & Filter hero for the Home tab's Editing group
//          (CONTRACT 3.17): Sort A to Z, Sort Z to A, Custom Sort..., then
//          Filter (checked while the sheet has an AutoFilter), Clear and
//          Reapply. The two sort rows are RELABELLED by what the sort key
//          holds, as Excel's are (Smallest to Largest for numbers, Oldest to
//          Newest for dates; measured live, editingRules.ts "Sort & Filter's
//          row labels") -- same commands, same test ids.
// CONTEXT: Rendered for the catalog item "sortFilter". The sort rows run the
//          Sorting extension's commands (Excel's rules: the selection when
//          several cells are selected, the block around the active cell with
//          its header guess otherwise, the Sort Warning for one column of wider
//          data) and the filter rows the AutoFilter extension's -- the same ids
//          the Data menu runs, so the two menus cannot disagree.
//
//          THE FILTER ROWS' STATE is the AutoFilter extension's own, pushed
//          through the feature-neutral seam @api/autoFilterService
//          (`getAutoFilterStatus` + `onChange`): the ribbon never asks the
//          backend and never imports the extension. Filter is a
//          menuitemcheckbox checked while the active sheet HAS a filter.
//          Clear and Reapply are live only while data is actually FILTERED --
//          live Excel greys both for a filter that hides nothing (editing-ext's
//          GetEnabledMso probe, 2026-10-04: SortClear / FilterReapply en=False
//          at stage "on", True at "filtered"), which is one step stricter than
//          CONTRACT 3.17's "Reapply: a filter exists"; the Data menu follows
//          Excel the same way.
//
//          The subscription lives in SortFilterMenuRows, which mounts only
//          while the menu is open (a closed Popover renders nothing), so a
//          closed button holds no listener; an open menu follows a change
//          published under it.
//
//          A HERO in the band: Excel's large button, the 30px picture over
//          "Sort & / Filter v" (labelLines 2, as Find & Select beside it -- two
//          heroes in one group must agree, or their icons sit 6px apart).
//          Outside the band CommandButton is a standard 28px button.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { RibbonIcon } from "@api";
import { ExtensionCommands } from "@api/commands";
import { getAutoFilterStatus, onChange as onAutoFilterChange } from "@api/autoFilterService";
import { MenuButton, CommandButton, MenuItem, MenuSeparator, HERO_ICON_SIZE, ICON_SIZE_SM } from "@api/layout";
import { useGridState } from "@api/grid";
import { getCell, getStyle, getViewportCells } from "@api/lib";
import { activeCellOf } from "@api/activeCell";
import { normaliseBlock } from "@api/selectionBlocks";
import type { Selection } from "@api/types";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { isDateFormatName, sortKindOf, SORT_LABELS, type SortKeyCell, type SortValueKind } from "./editingRules";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** useSyncExternalStore's subscribe: the seam's listener receives the status,
 *  React's re-reads it through getAutoFilterStatus (a stable object between
 *  changes, so an unchanged status re-renders nothing). */
function subscribe(listener: () => void): () => void {
  return onAutoFilterChange(() => listener());
}

/** The longest stretch of the key column the labels read: a whole column
 *  selected is a million rows, and the words are not worth reading them. */
const SORT_KEY_READ_LIMIT = 10000;

/** A cell as get_cell / get_viewport_cells report it, read for the labels. */
type LabelCell = { row: number; display: string; overflow?: string; styleIndex: number } | null;

/** The labels' kind for `selection` (editingRules.sortKindOf), read from the
 *  backend: the active cell for one cell, else the active cell's column over
 *  the main block (bounded). Rejects when a read fails. */
async function readSortKind(selection: Selection): Promise<SortValueKind> {
  const block = normaliseBlock(selection);
  const active = activeCellOf(selection)!;
  const single = block.startRow === block.endRow && block.startCol === block.endCol;
  const lastRow = Math.min(block.endRow, block.startRow + SORT_KEY_READ_LIMIT - 1);
  const read: LabelCell[] = single
    ? [await getCell(active.row, active.col)]
    : await getViewportCells(block.startRow, active.col, lastRow, active.col);
  const styles = new Map<number, Promise<boolean>>();
  const isDate = (styleIndex: number): Promise<boolean> => {
    let known = styles.get(styleIndex);
    if (!known) {
      known = getStyle(styleIndex).then((style) => isDateFormatName(style?.numberFormat ?? "General"));
      styles.set(styleIndex, known);
    }
    return known;
  };
  const cells: SortKeyCell[] = [];
  for (const cell of read) {
    if (!cell) continue;
    // `overflow` is the engine's own typing: "numeric" for a number, a
    // boolean or an error (absent = text); a number under "@" is text.
    if (cell.overflow === "numeric" || cell.overflow === "unrepresentable") {
      cells.push({ row: cell.row, kind: (await isDate(cell.styleIndex)) ? "date" : "number" });
    } else if (cell.display !== "") {
      cells.push({ row: cell.row, kind: "text" });
    }
  }
  return sortKindOf(cells, block.startRow, single);
}

/**
 * The kind the sort rows are labelled by, asked when the menu opens and again
 * if the selection moves while it is open. "text" (A to Z, the generic words)
 * while the read is in flight and when it fails: the commands are the same
 * either way, so a label is never worth a refusal.
 */
function useSortKind(selection: Selection | null | undefined): SortValueKind {
  const key = selection
    ? `${selection.startRow},${selection.startCol},${selection.endRow},${selection.endCol},${selection.activeRow ?? ""},${selection.activeCol ?? ""}`
    : "";
  const [state, setState] = useState<{ key: string; kind: SortValueKind }>({ key: "", kind: "text" });
  useEffect(() => {
    if (!selection) return undefined;
    let live = true;
    Promise.resolve()
      .then(() => readSortKind(selection))
      .then((kind) => {
        if (live) setState({ key, kind });
      })
      .catch(() => {
        if (live) setState({ key, kind: "text" });
      });
    return () => {
      live = false;
    };
    // `selection` is described by `key`; an equal key asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.kind : "text";
}

/** The menu's rows. Mounted only while the menu is open. */
function SortFilterMenuRows({ testId }: { testId: string }): React.ReactElement {
  const status = useSyncExternalStore(subscribe, getAutoFilterStatus);
  const filtered = status.hasFilter && status.isDataFiltered;
  const words = SORT_LABELS[useSortKind(useGridState().selection)];

  return (
    <>
      <MenuItem
        icon={<RibbonIcon.SortAscending size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-ascending`}
        onSelect={() => void runCommand(ExtensionCommands.SORT_ASCENDING)}
      >
        {words.ascending}
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.SortDescending size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-descending`}
        onSelect={() => void runCommand(ExtensionCommands.SORT_DESCENDING)}
      >
        {words.descending}
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.Sort size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-custom`}
        onSelect={() => void runCommand(ExtensionCommands.SORT_CUSTOM)}
      >
        Custom Sort...
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        role="menuitemcheckbox"
        checked={status.hasFilter}
        icon={<RibbonIcon.Filter size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-filter`}
        shortcutCommandId={ExtensionCommands.FILTER_TOGGLE}
        onSelect={() => void runCommand(ExtensionCommands.FILTER_TOGGLE)}
      >
        Filter
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.ClearFilter size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-clear`}
        disabled={!filtered}
        onSelect={() => void runCommand(ExtensionCommands.FILTER_CLEAR)}
      >
        Clear
      </MenuItem>
      <MenuItem
        icon={<RibbonIcon.Refresh size={MENU_ROW_ICON_SIZE} />}
        testId={`${testId}-reapply`}
        disabled={!filtered}
        onSelect={() => void runCommand(ExtensionCommands.FILTER_REAPPLY)}
      >
        Reapply
      </MenuItem>
    </>
  );
}

export function SortFilterMenuButton({ item, band }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;

  return (
    <MenuButton
      trigger={
        <CommandButton
          icon={<RibbonIcon.SortFilter size={band ? HERO_ICON_SIZE : ICON_SIZE_SM} />}
          label={item.shortLabel ?? item.label}
          chevron
          labelLines={2}
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={testId}
        />
      }
    >
      <SortFilterMenuRows testId={testId} />
    </MenuButton>
  );
}
