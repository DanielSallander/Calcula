//! FILENAME: app/extensions/GoToSpecial/index.ts
// PURPOSE: Go To Special extension entry point.
// CONTEXT: Registers the dialog for selecting cells by type, the
//          `goToSpecial.select { criteria }` command Excel's Find & Select quick
//          items run (Formulas, Notes, Conditional Formatting, Constants, Data
//          Validation), and Excel's Go To dialog with its `navigate.goTo`
//          command (F5 / Ctrl+G) and Edit > Go To... item. Uses ExtensionModule
//          lifecycle (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionCommands } from "@api/commands";
import { showToast } from "@api/notifications";
import { registerMenuItem, unregisterMenuItem, showDialog } from "@api/ui";
import { GoToSpecialDialog } from "./components/GoToSpecialDialog";
import { GoToDialog } from "./components/GoToDialog";
import { isGoToSpecialCriteria, selectSpecialCells, GO_TO_SPECIAL_CRITERIA } from "./lib/selectSpecialCells";

/** Excel's Go To dialog (F5 / Ctrl+G). */
export const GO_TO_DIALOG_ID = "go-to";
/** Edit > Go To..., next to Find... and Replace... */
export const GO_TO_MENU_ITEM_ID = "edit:goTo";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Commands
// ============================================================================

/**
 * `goToSpecial.select { criteria }`: select the matching cells directly, with
 * no dialog -- the whole sheet from one selected cell, inside the selection
 * otherwise. The SAME search and selection the dialog's OK runs
 * (lib/selectSpecialCells.ts), so a quick item and the dialog cannot select
 * differently. A criteria it does not know is refused out loud: a quick item
 * wired to a misspelled criteria must not look like "nothing matched".
 */
async function runSelectCommand(args: unknown): Promise<void> {
  const criteria = (args as { criteria?: unknown } | undefined)?.criteria;
  if (!isGoToSpecialCriteria(criteria)) {
    showToast(
      `Go To Special does not know the criteria "${String(criteria)}". ` +
        `Known: ${GO_TO_SPECIAL_CRITERIA.join(", ")}.`,
      { variant: "error" },
    );
    return;
  }
  await selectSpecialCells(criteria);
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[GoToSpecial] Activating...");

  context.ui.dialogs.register({
    id: "go-to-special",
    component: GoToSpecialDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("go-to-special"));

  context.commands.register(ExtensionCommands.GO_TO_SPECIAL_SELECT, runSelectCommand);
  cleanupFns.push(() => context.commands.unregister(ExtensionCommands.GO_TO_SPECIAL_SELECT));

  // Excel's Go To: F5 and Ctrl+G (keybindings.ts) and Find & Select > Go To...
  // It navigates -- the way BACK to the cells -- so, like the Name Box, it is
  // not refused while an object holds the selection, nor on a canvas sheet
  // (a reference can name a cell on another sheet).
  context.ui.dialogs.register({ id: GO_TO_DIALOG_ID, component: GoToDialog, priority: 100 });
  cleanupFns.push(() => context.ui.dialogs.unregister(GO_TO_DIALOG_ID));
  context.commands.register(ExtensionCommands.GO_TO, () => showDialog(GO_TO_DIALOG_ID));
  cleanupFns.push(() => context.commands.unregister(ExtensionCommands.GO_TO));

  // Edit > Go To..., after Find... / Replace... (Standard Menus builds Edit;
  // an item added before it registers is appended when it does).
  registerMenuItem("edit", {
    id: GO_TO_MENU_ITEM_ID,
    label: "Go To...",
    shortcut: "Ctrl+G",
    commandId: ExtensionCommands.GO_TO,
  });
  cleanupFns.push(() => unregisterMenuItem("edit", GO_TO_MENU_ITEM_ID));

  console.log("[GoToSpecial] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[GoToSpecial] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[GoToSpecial] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[GoToSpecial] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.go-to-special",
    name: "Go To Special",
    version: "1.0.0",
    description: "Select cells by type (formulas, constants, blanks, etc.).",
  },
  activate,
  deactivate,
};

export default extension;
