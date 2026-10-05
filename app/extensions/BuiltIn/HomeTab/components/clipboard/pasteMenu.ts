//! FILENAME: app/extensions/BuiltIn/HomeTab/components/clipboard/pasteMenu.ts
// PURPOSE: What Excel's Paste menu holds -- its headings, its rows in Excel's
//          order, the picture and the command of each -- and WHEN its variant
//          rows may run (including the stale-clipboard question, asked apart
//          because it needs a round trip).
// CONTEXT: Home tab = Excel's Home tab, contract 3.1 (2026-10-04). Data and a
//          rule, no React: PasteSplitButton.tsx draws them, tests read them,
//          and a component file that exports only its component keeps React
//          Fast Refresh working.

import type React from "react";
import { RibbonIcon, type RibbonIconProps } from "@api";
import { CoreCommands } from "@api/commands";
import { getInternalClipboard, type ClipboardData } from "@api/lib";
import { internalClipboardIsCurrent } from "@api/cellClipboard";
import { canvasOwnsObjectClipboard } from "@api/objectClipboard";

/**
 * Excel's large split: the label "Paste" on its own line and the chevron
 * under it (Excel's "Paste / v", the owner's screenshot of the Clipboard
 * group). A one-word label on two lines is exactly that -- splitHeroLabel
 * keeps the word on line 1 and gives the chevron line 2. Ignored outside the
 * band. The Paste hero is alone in its group, so no neighbour's icon line has
 * to agree with it.
 */
export const PASTE_LABEL_LINES = 2;

/** One row of the Paste menu. */
export interface PasteMenuRow {
  /** The row's test id is `fmt-paste-<slug>` (contract 3.1). */
  slug: string;
  /** Excel's words. */
  label: string;
  /** Its picture (contract 7's Paste* keys), drawn at 20px. */
  icon: React.ComponentType<RibbonIconProps>;
  /**
   * The command the row runs, or null for the "Paste" row, which runs the
   * main half's DOOR (the group's handleItemClick) rather than a fixed id.
   */
  commandId: string | null;
  /** Show this command's LIVE binding as the row's shortcut chip (none is
   *  bound today but Paste's and Paste Special's; a user's own binding for a
   *  variant then shows on its row). */
  shortcutCommandId?: string;
}

/** A heading and the rows under it. */
export interface PasteMenuSection {
  heading: string;
  rows: readonly PasteMenuRow[];
}

/**
 * The menu above its separator, in Excel's order, under Excel's headings.
 *
 * Keep Source Formatting is plain PASTE: a paste already carries the source's
 * whole style (useClipboard copies the styleIndex), which is exactly what
 * Excel's row does. It shows no chip, though: Ctrl+V's chip belongs to the
 * "Paste" row alone, or the menu would offer one key for two rows.
 */
export const PASTE_MENU_SECTIONS: readonly PasteMenuSection[] = [
  {
    heading: "Paste",
    rows: [
      { slug: "paste", label: "Paste", icon: RibbonIcon.Paste, commandId: null, shortcutCommandId: CoreCommands.PASTE },
      {
        slug: "formulas",
        label: "Formulas",
        icon: RibbonIcon.PasteFormulas,
        commandId: CoreCommands.PASTE_FORMULAS,
        shortcutCommandId: CoreCommands.PASTE_FORMULAS,
      },
      {
        slug: "formulasNumberFormats",
        label: "Formulas & Number Formatting",
        icon: RibbonIcon.PasteFormulasNumberFormats,
        commandId: CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
        shortcutCommandId: CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
      },
      {
        slug: "keepSource",
        label: "Keep Source Formatting",
        icon: RibbonIcon.PasteKeepSourceFormatting,
        commandId: CoreCommands.PASTE,
      },
      {
        slug: "noBorders",
        label: "No Borders",
        icon: RibbonIcon.PasteNoBorders,
        commandId: CoreCommands.PASTE_NO_BORDERS,
        shortcutCommandId: CoreCommands.PASTE_NO_BORDERS,
      },
      {
        slug: "columnWidths",
        label: "Keep Source Column Widths",
        icon: RibbonIcon.PasteColumnWidths,
        commandId: CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
        shortcutCommandId: CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
      },
      {
        slug: "transpose",
        label: "Transpose",
        icon: RibbonIcon.PasteTranspose,
        commandId: CoreCommands.PASTE_TRANSPOSE,
        shortcutCommandId: CoreCommands.PASTE_TRANSPOSE,
      },
    ],
  },
  {
    heading: "Paste Values",
    rows: [
      {
        slug: "values",
        label: "Values",
        icon: RibbonIcon.PasteValues,
        commandId: CoreCommands.PASTE_VALUES,
        shortcutCommandId: CoreCommands.PASTE_VALUES,
      },
      {
        slug: "valuesNumberFormats",
        label: "Values & Number Formatting",
        icon: RibbonIcon.PasteValuesNumberFormats,
        commandId: CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
        shortcutCommandId: CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
      },
      {
        slug: "valuesSourceFormatting",
        label: "Values & Source Formatting",
        icon: RibbonIcon.PasteValuesSourceFormatting,
        commandId: CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
        shortcutCommandId: CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
      },
    ],
  },
  {
    heading: "Other Paste Options",
    rows: [
      {
        slug: "formatting",
        label: "Formatting",
        icon: RibbonIcon.PasteFormatting,
        commandId: CoreCommands.PASTE_FORMATTING,
        shortcutCommandId: CoreCommands.PASTE_FORMATTING,
      },
      {
        slug: "link",
        label: "Paste Link",
        icon: RibbonIcon.PasteLink,
        commandId: CoreCommands.PASTE_LINK,
        shortcutCommandId: CoreCommands.PASTE_LINK,
      },
    ],
  },
];

/** The row under the separator. */
export const PASTE_SPECIAL_ROW: PasteMenuRow = {
  slug: "special",
  label: "Paste Special...",
  icon: RibbonIcon.PasteSpecial,
  commandId: CoreCommands.PASTE_SPECIAL,
  shortcutCommandId: CoreCommands.PASTE_SPECIAL,
};

/**
 * Why the variant rows are greyed: the first of the commands' own questions
 * that fails -- or, for the one question that needs a round trip, that it is
 * still being asked (`pending`).
 */
export type PasteVariantsBlock = "canvas" | "nothingCopied" | "afterCut" | "stale" | "pending";

/** The synchronous half of the answer: a block, or the copied cells whose
 *  freshness is still to be asked (`pasteFreshnessBlock`). */
export interface PasteVariantsRead {
  block: "canvas" | "nothingCopied" | "afterCut" | null;
  /** The internal clipboard, when the synchronous questions all passed. */
  clipboard: ClipboardData | null;
}

/**
 * Whether the variant rows (every row but Paste) may run right now, or why
 * not -- asked in the order the commands themselves ask (PasteSpecial
 * index.ts `pasteVariant`, then pasteRefusals.ts): a canvas sheet (no cells
 * to paste into), then an empty internal clipboard (none at all, or no
 * cells), then a CUT (Excel allows only plain Paste until a cut is pasted).
 * The commands' NEXT question -- has another program copied since? -- needs
 * the system clipboard, so it is asked apart (`pasteFreshnessBlock`).
 *
 * A read that throws counts as nothing copied. The two mistakes are not equal:
 * a row greyed over an unreadable clipboard leaves Paste, which still works;
 * a row that looks available and then refuses costs the user a dialog.
 */
export function readPasteVariants(): PasteVariantsRead {
  try {
    if (canvasOwnsObjectClipboard()) return { block: "canvas", clipboard: null };
    const clipboard = getInternalClipboard();
    if (!clipboard || clipboard.cells.length === 0) return { block: "nothingCopied", clipboard: null };
    if (clipboard.isCut) return { block: "afterCut", clipboard: null };
    return { block: null, clipboard };
  } catch {
    return { block: "nothingCopied", clipboard: null };
  }
}

/** The synchronous questions only (see readPasteVariants). */
export function pasteVariantsBlock(): PasteVariantsBlock | null {
  return readPasteVariants().block;
}

/**
 * The commands' second question (pasteRefusals.ts): is the internal clipboard
 * still what the clipboard holds, or did another program copy newer text
 * since? `stale` when it did -- every variant would then refuse with a dialog
 * (review finding, 2026-10-04: the menu skipped this question, so after a copy
 * in Notepad all twelve rows looked live and each one refused). Asked through
 * `@api/cellClipboard`, the SAME rule the commands and plain Paste use.
 *
 * A FAILED read is null (live), not stale: a failed read is not "newer text",
 * and the command, which asks again, falls back to the internal clipboard the
 * same way. Greying would claim a change nobody measured.
 */
export async function pasteFreshnessBlock(clipboard: ClipboardData): Promise<"stale" | null> {
  try {
    return (await internalClipboardIsCurrent(clipboard)) ? null : "stale";
  } catch {
    return null;
  }
}
