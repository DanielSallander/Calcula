//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/index.ts
// PURPOSE: Format Cells Dialog extension module.
// CONTEXT: Registers the Format Cells dialog and the FORMAT_CELLS command.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { CoreCommands } from "@api/commands";
import { DialogExtensions } from "@api/ui";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { FormatCellsDialog } from "./FormatCellsDialog";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
/** Undoes this activation's command registration (see deactivate). */
let unregisterCommand: (() => void) | null = null;

/** The tab a FORMAT_CELLS caller asked for (`{ tab: "number" }`), or null. */
function requestedTab(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const tab = (args as { tab?: unknown }).tab;
  return typeof tab === "string" && tab !== "" ? tab : null;
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[FormatCellsExtension] Already activated, skipping.");
    return;
  }

  console.log("[FormatCellsExtension] Activating...");

  // Register the dialog component
  DialogExtensions.registerDialog({
    id: "format-cells",
    component: FormatCellsDialog,
    priority: 200,
  });

  // Register the FORMAT_CELLS command. Every door to the dialog (Ctrl+1, the
  // Format menu, the ribbon's Format Cells button AND its "More Number
  // Formats..." / "More Fill Options..." rows, the grid's context menu) comes
  // through here, and the dialog formats Core's selection -- so while something
  // else owns the selection (BUG-0185) it does not open at all. The two "More"
  // rows opened the dialog directly, past this check, until the review of
  // BUG-0185; they now pass `{ tab }`, which opens it on that tab.
  context.commands.register(CoreCommands.FORMAT_CELLS, (args?: unknown) => {
    if (refuseIfSelectionOwned("Format Cells")) return;
    const tab = requestedTab(args);
    if (tab === null) DialogExtensions.openDialog("format-cells");
    else DialogExtensions.openDialog("format-cells", { tab });
  });
  // Deactivate takes it away: a deactivated extension must not keep answering
  // the registry's Ctrl+1 (D3 class).
  unregisterCommand = () => context.commands.unregister(CoreCommands.FORMAT_CELLS);

  isActivated = true;
  console.log("[FormatCellsExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[FormatCellsExtension] Deactivating...");
  unregisterCommand?.();
  unregisterCommand = null;
  DialogExtensions.unregisterDialog("format-cells");
  isActivated = false;
  console.log("[FormatCellsExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.format-cells",
    name: "Format Cells Dialog",
    version: "1.0.0",
    description: "Format Cells dialog for comprehensive cell formatting.",
  },
  activate,
  deactivate,
};

export default extension;
