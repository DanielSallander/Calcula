//! FILENAME: app/extensions/BuiltIn/HomeTab/components/cells/FormatMenuButton.tsx
// PURPOSE: Excel's Format menu for the Home tab's Cells group (CONTRACT 3.13):
//          a hero "Format v" opening four headed sections -- Cell Size (Row
//          Height..., AutoFit Row Height, Column Width..., AutoFit Column
//          Width, Default Width...), Visibility (Hide & Unhide >), Organize
//          Sheets (Rename Sheet, Move or Copy Sheet..., Tab Color >) and
//          Protection (Protect / Unprotect Sheet..., Lock Cell, Format
//          Cells...).
// CONTEXT: Rendered for the catalog item "formatMenu". Every row runs a command
//          somebody else owns (runCommand.ts says who) -- the same ids the
//          sheet-tab menu, the grid's right-click menu, the Review menu and the
//          keyboard run -- so the ribbon decides nothing about HOW.
//
//          THE MENU IS EXCEL 365'S, read off its own menu (scratchpad
//          excel-icons/menu-Format-1.png, and home-cells/probe-*.png for the two
//          flyouts, captured from a fresh hidden Excel through UI Automation on
//          2026-10-04):
//          - pictures on Row Height, Column Width, Rename Sheet, Protect Sheet,
//            Lock Cell and Format Cells only; every other row RESERVES the
//            picture column (MENU_ICON_BLANK), so the labels line up;
//          - a rule closes each section, and two more split a section where
//            Excel splits it: Row Height | Column Width, and the sheet's
//            protection | Format Cells...;
//          - Hide & Unhide > is Hide Rows, Hide Columns, Hide Sheet, a rule,
//            Unhide Rows, Unhide Columns, Unhide Sheet... -- no pictures, the
//            column still reserved; Unhide Sheet... is GREYED when no sheet is
//            hidden (measured: a fresh one-sheet workbook shows it greyed),
//            where Calcula's tab menu used to say so in an alert afterwards;
//          - Tab Color > is Theme Colors, Standard Colors, then "No Color" and
//            "More Colors..." BELOW the swatches (measured), the place Excel's
//            Fill Color puts "No Fill" -- not first, as Font Color's
//            "Automatic" is.
//
//          STATE IS READ WHEN THE MENU OPENS, never per render: FormatMenuRows
//          mounts only while the menu is open (a closed Popover renders
//          nothing), so a mount IS an opening, and a closed button costs no
//          backend round trip on every selection change. Four facts:
//          - is the sheet protected? -- the Protect row's label ("Unprotect
//            Sheet..." when it is, Excel's wording) and Lock Cell's greying;
//          - is the ACTIVE cell locked? -- Lock Cell's tick. The active cell
//            is `activeRow ?? endRow` / `activeCol ?? endCol`, the cell the
//            grid draws as active (Calcula's selection model keeps the anchor
//            in start*, the active cell in end*, and the aliases win when set)
//            -- the same cell protection.toggleLockCell reads, so the tick and
//            the toggle can never disagree about which cell they mean;
//          - is any sheet "hidden"? -- Unhide Sheet...'s greying ("veryHidden"
//            does not count: Unhide cannot show one), together with the
//            command's own refusal (`commandRefusalFor`, e.g. while a formula
//            is being written);
//          - the active sheet's tab colour -- the palette's selected swatch.
//          A read that FAILS never takes a command away: the label falls back
//          to "Protect Sheet...", the tick to unticked, Unhide Sheet... to
//          live, and each command then decides on its own (they all read the
//          workbook themselves and refuse in their own words). A read still
//          in flight greys the two rows whose state it decides (Lock Cell,
//          Unhide Sheet...) -- for the few milliseconds it takes -- so no click
//          lands on a guess.
//
//          TAB COLOR SENDS HEX OR NULL ONLY. core.sheet.setTabColor takes
//          `{ color: "#rrggbb" | null }`, so the palette is given no
//          onThemeColorChange: a theme pick arrives as its resolved hex (a tab
//          colour is a fixed colour in Calcula; it does not follow the theme).
//          "No Color" sends null.
//
//          A HERO in the band: Excel's large button, the 30px picture over ONE
//          line "Format v", agreeing with the Insert and Delete heroes beside it
//          (two-line heroes' pictures sit 6px higher). Outside the band
//          CommandButton is a standard 28px button.

import React, { useEffect, useState } from "react";
import { RibbonIcon } from "@api";
import { CoreCommands, ExtensionCommands } from "@api/commands";
import { commandRefusalFor } from "@api/commandRefusals";
import { getGridStateSnapshot } from "@api/grid";
import { getCellProtection, getSheets, isSheetProtected } from "@api/lib";
import {
  MenuButton,
  CommandButton,
  MenuItem,
  MenuSub,
  MenuHeading,
  MenuSeparator,
  MENU_ICON_BLANK,
  ColorPalette,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
} from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import { activeCellOf } from "@api/activeCell";
import { MENU_ROW_ICON_SIZE, runCommand } from "../runCommand";

/** Every row's words, as Excel's Format menu says them. */
export const FORMAT_MENU_LABELS = {
  cellSize: "Cell Size",
  rowHeight: "Row Height...",
  autoFitRowHeight: "AutoFit Row Height",
  columnWidth: "Column Width...",
  autoFitColumnWidth: "AutoFit Column Width",
  defaultWidth: "Default Width...",
  visibility: "Visibility",
  hideUnhide: "Hide & Unhide",
  hideRows: "Hide Rows",
  hideColumns: "Hide Columns",
  hideSheet: "Hide Sheet",
  unhideRows: "Unhide Rows",
  unhideColumns: "Unhide Columns",
  unhideSheet: "Unhide Sheet...",
  organizeSheets: "Organize Sheets",
  renameSheet: "Rename Sheet",
  moveOrCopySheet: "Move or Copy Sheet...",
  tabColor: "Tab Color",
  noColor: "No Color",
  protection: "Protection",
  protectSheet: "Protect Sheet...",
  unprotectSheet: "Unprotect Sheet...",
  lockCell: "Lock Cell",
  formatCells: "Format Cells...",
} as const;

/**
 * What the menu shows, read when it opens. `null` = the read is still in
 * flight. A FAILED read resolves to the value that leaves the decision to the
 * command (see the file header), never to null.
 */
export interface FormatMenuFacts {
  protectedSheet: boolean | null;
  activeCellLocked: boolean | null;
  hasHiddenSheet: boolean | null;
  /** The active sheet's tab colour ("#rrggbb"), or null for none. */
  tabColor: string | null;
}

const PENDING: FormatMenuFacts = {
  protectedSheet: null,
  activeCellLocked: null,
  hasHiddenSheet: null,
  tabColor: null,
};

/** The cell the grid draws as active -- the Home tab's one rule, kept in
 *  ../activeCell.ts and re-exported here for this menu's callers. */
export { activeCellOf };

/**
 * Start the menu's four reads; `land` is called once per fact as it arrives.
 * Each read is independent, so a slow or failing one never holds the others.
 * Started inside a resolved promise so a failure of ANY kind -- an IPC error,
 * a missing export -- lands in the catch rather than throwing out of an
 * effect. Returns a cancel for an unmount before they land.
 */
function readFacts(land: (patch: Partial<FormatMenuFacts>) => void): () => void {
  let cancelled = false;
  const set = (patch: Partial<FormatMenuFacts>) => {
    if (!cancelled) land(patch);
  };

  Promise.resolve()
    .then(() => isSheetProtected())
    .then(
      (isProtected) => set({ protectedSheet: isProtected === true }),
      () => set({ protectedSheet: false }),
    );

  const active = activeCellOf(getGridStateSnapshot()?.selection);
  if (active) {
    Promise.resolve()
      .then(() => getCellProtection(active.row, active.col))
      .then(
        (protection) => set({ activeCellLocked: protection?.locked === true }),
        () => set({ activeCellLocked: false }),
      );
  } else {
    set({ activeCellLocked: false });
  }

  Promise.resolve()
    .then(() => getSheets())
    .then(
      (result) => {
        const sheets = result?.sheets ?? [];
        const activeSheet = sheets.find((s) => s.index === result.activeIndex) ?? sheets[result.activeIndex];
        set({
          hasHiddenSheet: sheets.some((s) => s.visibility === "hidden"),
          tabColor: activeSheet?.tabColor ? activeSheet.tabColor : null,
        });
      },
      // Unknown: Unhide Sheet... stays live and the command's own refusal
      // (it knows the strip's sheets) answers if nothing is hidden.
      () => set({ hasHiddenSheet: true, tabColor: null }),
    );

  return () => {
    cancelled = true;
  };
}

/** A command row: its picture (or the reserved blank), its test id, its command. */
function CommandRow({
  testId,
  icon,
  commandId,
  shortcut,
  children,
}: {
  testId: string;
  icon: React.ReactNode;
  commandId: string;
  /** Show the command's live binding (only where a key runs exactly this row). */
  shortcut?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <MenuItem
      icon={icon}
      testId={testId}
      shortcutCommandId={shortcut ? commandId : undefined}
      onSelect={() => void runCommand(commandId)}
    >
      {children}
    </MenuItem>
  );
}

/** The menu's rows. Mounted only while the menu is open (see the header). */
function FormatMenuRows({ testId }: { testId: string }): React.ReactElement {
  const [facts, setFacts] = useState<FormatMenuFacts>(PENDING);
  // Asked once per opening, synchronously: the registry answers from state the
  // owner already holds (a formula being written, the strip's sheet list).
  const [unhideRefusal] = useState(() => commandRefusalFor(CoreCommands.SHEET_UNHIDE));

  useEffect(() => readFacts((patch) => setFacts((was) => ({ ...was, ...patch }))), []);

  const L = FORMAT_MENU_LABELS;
  const picture = (icon: React.ComponentType<{ size?: number }>) =>
    React.createElement(icon, { size: MENU_ROW_ICON_SIZE });
  const id = (slug: string) => `${testId}-${slug}`;
  const runTabColor = (color: string | null) => void runCommand(CoreCommands.SHEET_TAB_COLOR, { color });

  return (
    <>
      <MenuHeading>{L.cellSize}</MenuHeading>
      <CommandRow testId={id("rowHeight")} icon={picture(RibbonIcon.RowHeight)} commandId={CoreCommands.ROW_HEIGHT}>
        {L.rowHeight}
      </CommandRow>
      <CommandRow testId={id("autoFitRowHeight")} icon={MENU_ICON_BLANK} commandId={CoreCommands.AUTOFIT_ROW_HEIGHT}>
        {L.autoFitRowHeight}
      </CommandRow>
      <MenuSeparator />
      <CommandRow
        testId={id("columnWidth")}
        icon={picture(RibbonIcon.ColumnWidth)}
        commandId={CoreCommands.COLUMN_WIDTH}
      >
        {L.columnWidth}
      </CommandRow>
      <CommandRow
        testId={id("autoFitColumnWidth")}
        icon={MENU_ICON_BLANK}
        commandId={CoreCommands.AUTOFIT_COLUMN_WIDTH}
      >
        {L.autoFitColumnWidth}
      </CommandRow>
      <CommandRow testId={id("defaultWidth")} icon={MENU_ICON_BLANK} commandId={CoreCommands.DEFAULT_WIDTH}>
        {L.defaultWidth}
      </CommandRow>
      <MenuSeparator />

      <MenuHeading>{L.visibility}</MenuHeading>
      <MenuSub label={L.hideUnhide} icon={MENU_ICON_BLANK} testId={id("hideUnhide")}>
        <CommandRow testId={id("hideRows")} icon={MENU_ICON_BLANK} commandId={CoreCommands.HIDE_ROWS}>
          {L.hideRows}
        </CommandRow>
        <CommandRow testId={id("hideColumns")} icon={MENU_ICON_BLANK} commandId={CoreCommands.HIDE_COLUMNS}>
          {L.hideColumns}
        </CommandRow>
        <CommandRow testId={id("hideSheet")} icon={MENU_ICON_BLANK} commandId={CoreCommands.SHEET_HIDE}>
          {L.hideSheet}
        </CommandRow>
        <MenuSeparator />
        <CommandRow testId={id("unhideRows")} icon={MENU_ICON_BLANK} commandId={CoreCommands.UNHIDE_ROWS}>
          {L.unhideRows}
        </CommandRow>
        <CommandRow testId={id("unhideColumns")} icon={MENU_ICON_BLANK} commandId={CoreCommands.UNHIDE_COLUMNS}>
          {L.unhideColumns}
        </CommandRow>
        <MenuItem
          icon={MENU_ICON_BLANK}
          testId={id("unhideSheet")}
          disabled={unhideRefusal !== null || facts.hasHiddenSheet !== true}
          // Why it is greyed, for a journey or a curious inspector; the row
          // itself is natively disabled, as Excel's is, and says nothing.
          data-unavailable={unhideRefusal ?? (facts.hasHiddenSheet === false ? "No sheet is hidden." : undefined)}
          onSelect={() => void runCommand(CoreCommands.SHEET_UNHIDE)}
        >
          {L.unhideSheet}
        </MenuItem>
      </MenuSub>
      <MenuSeparator />

      <MenuHeading>{L.organizeSheets}</MenuHeading>
      <CommandRow
        testId={id("renameSheet")}
        icon={picture(RibbonIcon.RenameSheet)}
        commandId={CoreCommands.SHEET_RENAME}
      >
        {L.renameSheet}
      </CommandRow>
      <CommandRow testId={id("moveOrCopySheet")} icon={MENU_ICON_BLANK} commandId={CoreCommands.SHEET_MOVE_OR_COPY}>
        {L.moveOrCopySheet}
      </CommandRow>
      <MenuSub label={L.tabColor} icon={MENU_ICON_BLANK} testId={id("tabColor")}>
        <ColorPalette
          value={facts.tabColor}
          onChange={(hex) => runTabColor(hex)}
          allowAutomatic
          automaticLabel={L.noColor}
          automaticChip="none"
          automaticPlacement="afterColors"
          onAutomatic={() => runTabColor(null)}
          testId={id("tabColor-palette")}
        />
      </MenuSub>
      <MenuSeparator />

      <MenuHeading>{L.protection}</MenuHeading>
      <CommandRow
        testId={id("protectSheet")}
        icon={picture(RibbonIcon.ProtectSheet)}
        commandId={ExtensionCommands.PROTECT_SHEET_TOGGLE}
      >
        {facts.protectedSheet === true ? L.unprotectSheet : L.protectSheet}
      </CommandRow>
      <MenuItem
        role="menuitemcheckbox"
        checked={facts.activeCellLocked === true}
        icon={picture(RibbonIcon.Lock)}
        testId={id("lockCell")}
        // Greyed on a protected sheet (Excel; the backend would refuse the
        // change) and while the protection read is in flight.
        disabled={facts.protectedSheet !== false}
        onSelect={() => void runCommand(ExtensionCommands.LOCK_CELL_TOGGLE)}
      >
        {L.lockCell}
      </MenuItem>
      <MenuSeparator />
      <CommandRow
        testId={id("formatCells")}
        icon={picture(RibbonIcon.FormatCells)}
        commandId={CoreCommands.FORMAT_CELLS}
        // Ctrl+1 runs exactly this: its live chip, where it can be discovered.
        shortcut
      >
        {L.formatCells}
      </CommandRow>
    </>
  );
}

/** Excel's Format menu (catalog item "formatMenu"). */
export function FormatMenuButton({ item, band }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  const testId = `fmt-${item.id}`;

  return (
    <MenuButton
      ariaLabel={item.label}
      trigger={
        <CommandButton
          icon={<RibbonIcon.FormatMenu size={band ? HERO_ICON_SIZE : ICON_SIZE_SM} />}
          label={item.shortLabel ?? item.label}
          chevron
          labelLines={1}
          tooltip={tip.tooltip}
          shortcut={tip.shortcut}
          commandId={tip.commandId}
          data-testid={testId}
        />
      }
    >
      <FormatMenuRows testId={testId} />
    </MenuButton>
  );
}
