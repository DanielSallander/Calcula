//! FILENAME: app/extensions/BuiltIn/PasteSpecial/index.ts
// PURPOSE: Paste Special extension module.
// CONTEXT: Registers the Paste Special dialog and the PASTE_SPECIAL command.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { CoreCommands } from "@api/commands";
import { DialogExtensions } from "@api/ui";
import { getGridStateSnapshot } from "@api/state";
import { getInternalClipboard } from "@api/lib";
import { PasteSpecialDialog } from "./PasteSpecialDialog";
import { executePasteSpecial, executePasteLink } from "./pasteSpecialExecute";

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

  // Register the PASTE_SPECIAL command
  context.commands.register(CoreCommands.PASTE_SPECIAL, () => {
    DialogExtensions.openDialog("paste-special");
  });

  // Register quick-paste commands (Paste Values, Formulas, Formatting, Link)
  context.commands.register(CoreCommands.PASTE_VALUES, async () => {
    const clipboard = getInternalClipboard();
    const state = getGridStateSnapshot();
    if (!clipboard || !state?.selection) return;
    await executePasteSpecial(clipboard, state.selection, {
      pasteAttribute: "values",
      operation: "none",
      skipBlanks: false,
      transpose: false,
    }, state.config.totalRows, state.config.totalCols);
  });

  context.commands.register(CoreCommands.PASTE_FORMULAS, async () => {
    const clipboard = getInternalClipboard();
    const state = getGridStateSnapshot();
    if (!clipboard || !state?.selection) return;
    await executePasteSpecial(clipboard, state.selection, {
      pasteAttribute: "formulas",
      operation: "none",
      skipBlanks: false,
      transpose: false,
    }, state.config.totalRows, state.config.totalCols);
  });

  context.commands.register(CoreCommands.PASTE_FORMATTING, async () => {
    const clipboard = getInternalClipboard();
    const state = getGridStateSnapshot();
    if (!clipboard || !state?.selection) return;
    await executePasteSpecial(clipboard, state.selection, {
      pasteAttribute: "formats",
      operation: "none",
      skipBlanks: false,
      transpose: false,
    }, state.config.totalRows, state.config.totalCols);
  });

  context.commands.register(CoreCommands.PASTE_LINK, async () => {
    const clipboard = getInternalClipboard();
    const state = getGridStateSnapshot();
    if (!clipboard || !state?.selection) return;
    await executePasteLink(clipboard, state.selection, state.config.totalRows, state.config.totalCols);
  });

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
    storedContext.commands.unregister(CoreCommands.PASTE_VALUES);
    storedContext.commands.unregister(CoreCommands.PASTE_FORMULAS);
    storedContext.commands.unregister(CoreCommands.PASTE_FORMATTING);
    storedContext.commands.unregister(CoreCommands.PASTE_LINK);
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
    description: "Paste Special dialog for granular paste control (values, formulas, formats, operations, transpose).",
  },
  activate,
  deactivate,
};

export default extension;
