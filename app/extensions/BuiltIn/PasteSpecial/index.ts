//! FILENAME: app/extensions/BuiltIn/PasteSpecial/index.ts
// PURPOSE: Paste Special extension module.
// CONTEXT: Registers the Paste Special dialog, the PASTE_SPECIAL command, and
//          every paste VARIANT the Edit menu and the Home tab's Paste menu run:
//          the four quick pastes (Values, Formulas, Formatting, Link) and,
//          since the Home tab became Excel's (2026-10-04, contract section 4),
//          the six rows Excel's Paste menu adds -- Formulas & Number
//          Formatting, No Borders, Keep Source Column Widths, Transpose,
//          Values & Number Formatting, Values & Source Formatting. Excel's
//          "Keep Source Formatting" row is plain Paste (CoreCommands.PASTE):
//          Core's paste already carries the source style.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import type { Selection } from "@api/types";
import type { ClipboardData } from "@api/lib";
import { CoreCommands } from "@api/commands";
import { DialogExtensions } from "@api/ui";
import { getGridStateSnapshot } from "@api/state";
import { getInternalClipboard } from "@api/lib";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { alertAsync } from "@api/dialogs";
import { canvasOwnsObjectClipboard } from "@api/objectClipboard";
import { PasteSpecialDialog } from "./PasteSpecialDialog";
import {
  executePasteSpecial,
  executePasteLink,
  executePasteKeepSourceColumnWidths,
} from "./pasteSpecialExecute";
import { pasteRefusalSentence } from "./pasteRefusals";
import type { PasteAttribute } from "./types";

// ============================================================================
// The paste variants
// ============================================================================

/** A paste variant's write, after its command's own questions. */
type PasteRun = (
  clipboard: ClipboardData,
  selection: Selection,
  totalRows: number,
  totalCols: number,
  label: string,
) => Promise<boolean>;

/** A Paste Special attribute with no operation, no skip-blanks. */
function special(pasteAttribute: PasteAttribute, transpose = false): PasteRun {
  return (clipboard, selection, totalRows, totalCols, label) =>
    executePasteSpecial(
      clipboard,
      selection,
      { pasteAttribute, operation: "none", skipBlanks: false, transpose },
      totalRows,
      totalCols,
      label,
    );
}

/**
 * Every paste variant's command id, in Excel's Paste-menu order after the
 * four that came first -- what deactivate unregisters. Each is REGISTERED by
 * name in `activate` (not from this list): the shortcut census
 * (extensions/__tests__/builtinShortcutCensus.test.ts) reads registrations
 * from the source, and one behind a loop is one it -- and a reviewer --
 * cannot see.
 */
const PASTE_VARIANT_COMMANDS: readonly string[] = [
  CoreCommands.PASTE_VALUES,
  CoreCommands.PASTE_FORMULAS,
  CoreCommands.PASTE_FORMATTING,
  CoreCommands.PASTE_LINK,
  CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
  CoreCommands.PASTE_NO_BORDERS,
  CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
  CoreCommands.PASTE_TRANSPOSE,
  CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
  CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
];

/**
 * A variant's command. The questions only a COMMAND can ask come first --
 * a canvas has no cells, nothing may have been copied, the grid may have no
 * selection -- each said in one sentence instead of the silent `return` they
 * used to be. The executor then asks the rest (a cut, a stale clipboard, a
 * protected region: pasteRefusals.ts) and writes; it is shared with the
 * dialog.
 *
 * @param label - The door's name in a refusal ("Paste Values is not available ...").
 */
function pasteVariant(label: string, run: PasteRun): () => Promise<void> {
  return async () => {
    // Something else owns the selection (BUG-0185, an object selected on a
    // worksheet): its own toast, first, as every grid door says it.
    if (refuseIfSelectionOwned(label)) return;
    if (canvasOwnsObjectClipboard()) {
      void alertAsync(pasteRefusalSentence.canvas(label));
      return;
    }
    const clipboard = getInternalClipboard();
    if (!clipboard || clipboard.cells.length === 0) {
      void alertAsync(pasteRefusalSentence.nothingCopied(label));
      return;
    }
    const state = getGridStateSnapshot();
    if (!state?.selection) {
      void alertAsync(pasteRefusalSentence.noSelection(label));
      return;
    }
    try {
      await run(clipboard, state.selection, state.config.totalRows, state.config.totalCols, label);
    } catch (err) {
      // The executor has already told the user why (alertAsync) and closed
      // its undo step; the detail is for the log only.
      console.error(`[PasteSpecial] ${label} failed:`, err);
    }
  };
}

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
let storedContext: ExtensionContext | null = null;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[PasteSpecialExtension] Already activated, skipping.");
    return;
  }

  console.log("[PasteSpecialExtension] Activating...");

  // Register the dialog component
  DialogExtensions.registerDialog({
    id: "paste-special",
    component: PasteSpecialDialog,
    priority: 200,
  });

  // Register the PASTE_SPECIAL command. The dialog pastes into Core's
  // selection; while something else owns the selection (BUG-0185: a floating
  // grid's selected cell, Core's selection hidden under it) it does not open.
  // Nor after a CUT (Excel disables Paste Special until the cut is pasted --
  // measured live, GetEnabledMso("PasteSpecialDialog") is False after
  // Range.Cut), nor on a canvas sheet, which has no cells to paste into. The
  // quick commands below refuse in the execute functions they share with the
  // dialog.
  context.commands.register(CoreCommands.PASTE_SPECIAL, () => {
    const label = "Paste Special";
    if (refuseIfSelectionOwned(label)) return;
    if (canvasOwnsObjectClipboard()) {
      void alertAsync(pasteRefusalSentence.canvas(label));
      return;
    }
    if (getInternalClipboard()?.isCut) {
      void alertAsync(pasteRefusalSentence.afterCut(label));
      return;
    }
    DialogExtensions.openDialog("paste-special");
  });

  // The quick pastes (the Edit menu's Paste submenu).
  context.commands.register(CoreCommands.PASTE_VALUES, pasteVariant("Paste Values", special("values")));
  context.commands.register(CoreCommands.PASTE_FORMULAS, pasteVariant("Paste Formulas", special("formulas")));
  context.commands.register(CoreCommands.PASTE_FORMATTING, pasteVariant("Paste Formatting", special("formats")));
  context.commands.register(
    CoreCommands.PASTE_LINK,
    pasteVariant("Paste Link", (clipboard, selection, totalRows, totalCols, label) =>
      executePasteLink(clipboard, selection, totalRows, totalCols, label),
    ),
  );

  // The Home tab Paste menu's other rows (Excel's order).
  context.commands.register(
    CoreCommands.PASTE_FORMULAS_AND_NUMBER_FORMATS,
    pasteVariant("Paste Formulas & Number Formatting", special("formulasAndNumberFormats")),
  );
  context.commands.register(CoreCommands.PASTE_NO_BORDERS, pasteVariant("Paste (No Borders)", special("allExceptBorders")));
  context.commands.register(
    CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS,
    pasteVariant("Paste (Keep Source Column Widths)", (clipboard, selection, totalRows, totalCols, label) =>
      executePasteKeepSourceColumnWidths(clipboard, selection, totalRows, totalCols, label),
    ),
  );
  context.commands.register(CoreCommands.PASTE_TRANSPOSE, pasteVariant("Paste (Transpose)", special("all", true)));
  context.commands.register(
    CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS,
    pasteVariant("Paste Values & Number Formatting", special("valuesAndNumberFormats")),
  );
  context.commands.register(
    CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING,
    pasteVariant("Paste Values & Source Formatting", special("valuesAndSourceFormatting")),
  );

  storedContext = context;
  isActivated = true;
  console.log("[PasteSpecialExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[PasteSpecialExtension] Deactivating...");
  DialogExtensions.unregisterDialog("paste-special");
  if (storedContext) {
    storedContext.commands.unregister(CoreCommands.PASTE_SPECIAL);
    for (const id of PASTE_VARIANT_COMMANDS) {
      storedContext.commands.unregister(id);
    }
    storedContext = null;
  }
  isActivated = false;
  console.log("[PasteSpecialExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.paste-special",
    name: "Paste Special Dialog",
    version: "1.0.0",
    description:
      "Paste Special dialog and every paste variant (values, formulas, formats, link, transpose, " +
      "no borders, column widths, number formats, source formatting, operations).",
  },
  activate,
  deactivate,
};

export default extension;
