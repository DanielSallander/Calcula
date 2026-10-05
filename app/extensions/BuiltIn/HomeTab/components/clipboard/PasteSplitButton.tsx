//! FILENAME: app/extensions/BuiltIn/HomeTab/components/clipboard/PasteSplitButton.tsx
// PURPOSE: Excel's Paste split button for the Home tab's Clipboard group: the
//          picture runs Paste, the label and chevron open Excel's Paste menu --
//          Paste, Formulas, Formulas & Number Formatting, Keep Source
//          Formatting, No Borders, Keep Source Column Widths, Transpose; Values,
//          Values & Number Formatting, Values & Source Formatting; Formatting,
//          Paste Link; Paste Special...
// CONTEXT: Rendered for the catalog item "paste" (contract 3.1, 2026-10-04).
//          Built on @api/layout's SplitMenuButton, so the menu has the full
//          popup keyboard model. In the ribbon band it is Excel's LARGE split
//          (face "hero": the 30px picture on top, "Paste / v" below);
//          everywhere else -- the sidebar, a collapsed group's launcher flyout
//          -- it is the medium split, [icon Paste][v] in one 28px row. The rows
//          themselves, and the rule that greys them, are data in pasteMenu.ts.
//
//          ONE DOOR. The main half and the menu's "Paste" row both run the
//          group's item door, `state.handleItemClick(item)`, which runs
//          `clipboardDoorCommand("paste")` inside useHomeTabState -- the
//          command Ctrl+V runs in the same place (the canvas's object paste,
//          Controls' paste with a shape selected, the cell paste otherwise).
//          The call stays in useHomeTabState: objectClipboardDoorRule.test.ts
//          pins it there, so this file never asks the rule itself.
//
//          THE VARIANTS paste the INTERNAL cell clipboard, so -- exactly as
//          Excel greys them -- every row but Paste is disabled when nothing has
//          been copied, after a CUT (measured live: Excel greys every Paste row
//          but Paste after Range.Cut; the clipboard lane's report), and on a
//          canvas sheet (no cells to paste into), and -- the commands' next
//          question -- while another program has copied newer text since
//          (a STALE cell clipboard: each variant would refuse with a dialog).
//          The state is READ WHEN THE MENU OPENS, never per render: the cell
//          clipboard sends no change event, so a read per render would be no
//          fresher, and a closed button has no reason to touch it. The commands refuse on their own as well
//          (PasteSpecial pasteRefusals.ts), with the same questions first, so a
//          row left enabled by a race still does no harm.

import React, { useEffect, useState } from "react";
import { RibbonIcon } from "@api";
import {
  SplitMenuButton,
  MenuItem,
  MenuHeading,
  MenuSeparator,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
} from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { homeTabIcon } from "../homeTabIcons";
import { itemTooltip } from "../itemTooltip";
import { runCommand } from "../runCommand";
import {
  PASTE_LABEL_LINES,
  PASTE_MENU_SECTIONS,
  PASTE_SPECIAL_ROW,
  pasteFreshnessBlock,
  readPasteVariants,
  type PasteMenuRow,
  type PasteVariantsBlock,
} from "./pasteMenu";

/** Menu row pictures are drawn on the 20px grid (as the Merge menu's are). */
const MENU_ICON_SIZE = 20;

/**
 * The menu's rows. A component of its own so the enablement is read when it
 * MOUNTS -- and SplitMenuButton's Popover renders its children only while the
 * menu is open (nothing at all when closed), so a mount IS an opening. The
 * useState initializer runs once per mount and never on a re-render.
 *
 * Two halves. The synchronous questions (canvas, nothing copied, a cut) are
 * answered at once. When they all pass, the commands' NEXT question -- has
 * another program copied since? -- needs the system clipboard, so it is asked
 * once per opening: the variants are grey (`pending`) while it is in flight,
 * as the Format menu greys a row whose fact is still being read, grey
 * (`stale`) when another program's text is newer, live when the cells are
 * still current or the read failed (pasteMenu.ts, pasteFreshnessBlock).
 */
function PasteMenuRows({ itemId, onPaste }: { itemId: string; onPaste: () => void }): React.ReactElement {
  const [read] = useState(readPasteVariants);
  const [freshness, setFreshness] = useState<"pending" | "stale" | null>(() =>
    read.block === null && read.clipboard !== null ? "pending" : null,
  );

  useEffect(() => {
    if (read.block !== null || read.clipboard === null) return undefined;
    let live = true;
    void pasteFreshnessBlock(read.clipboard).then((answer) => {
      if (live) setFreshness(answer);
    });
    return () => {
      live = false;
    };
  }, [read]);

  const block: PasteVariantsBlock | null = read.block ?? freshness;

  const renderRow = (row: PasteMenuRow): React.ReactElement => {
    const door = row.commandId === null;
    // The Paste row is never greyed: it is the door Ctrl+V runs, which also
    // pastes the system clipboard's text and, on a canvas, objects.
    const unavailable = door ? null : block;
    const Icon = row.icon;
    return (
      <MenuItem
        key={row.slug}
        icon={<Icon size={MENU_ICON_SIZE} />}
        testId={`fmt-${itemId}-${row.slug}`}
        shortcutCommandId={row.shortcutCommandId}
        disabled={unavailable !== null}
        // Why a row is greyed, for a journey or a curious inspector; the row
        // itself is natively disabled, as Excel's are, and says nothing.
        data-unavailable={unavailable ?? undefined}
        onSelect={() => {
          if (row.commandId === null) onPaste();
          else void runCommand(row.commandId);
        }}
      >
        {row.label}
      </MenuItem>
    );
  };

  return (
    <>
      {PASTE_MENU_SECTIONS.map((section) => (
        <React.Fragment key={section.heading}>
          <MenuHeading>{section.heading}</MenuHeading>
          {section.rows.map(renderRow)}
        </React.Fragment>
      ))}
      <MenuSeparator />
      {renderRow(PASTE_SPECIAL_ROW)}
    </>
  );
}

/** Excel's Paste split button (catalog item "paste"). */
export function PasteSplitButton({ item, state, band }: HomeItemProps): React.ReactElement {
  const tip = itemTooltip(item);
  // 30px in the band's hero slot; outside the band the medium split fits its
  // icon to 20px, and the attribute says so too (the surfaces test reads it).
  const iconSize = band ? HERO_ICON_SIZE : ICON_SIZE_SM;
  const runDoor = (): void => {
    void state.handleItemClick(item);
  };

  return (
    <SplitMenuButton
      face={band ? "hero" : "labelled"}
      labelLines={PASTE_LABEL_LINES}
      icon={homeTabIcon(item.id, iconSize) ?? <RibbonIcon.Paste size={iconSize} />}
      label={item.label}
      tooltip={tip.tooltip}
      shortcut={tip.shortcut}
      commandId={tip.commandId}
      data-testid={`fmt-${item.id}`}
      onClick={runDoor}
      chevronLabel="Paste options"
      chevronTestId={`fmt-${item.id}-options`}
      menuLabel="Paste"
    >
      <PasteMenuRows itemId={item.id} onPaste={runDoor} />
    </SplitMenuButton>
  );
}
