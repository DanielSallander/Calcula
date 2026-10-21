//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/index.ts
// PURPOSE: Format Cells Dialog extension module.
// CONTEXT: Registers the Format Cells dialog and the FORMAT_CELLS command.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { CoreCommands } from "@api/commands";
import { DialogExtensions } from "@api/ui";
import { resolveCellTarget } from "@api/cellTarget";
import { FormatCellsDialog } from "./FormatCellsDialog";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
/** Undoes this activation's command registration (see deactivate). */
let unregisterCommand: (() => void) | null = null;

/** A non-empty string argument of a FORMAT_CELLS caller, or null. */
function stringArg(args: unknown, key: "tab" | "category"): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * What a FORMAT_CELLS caller asked the dialog to open on: `{ tab }` (the
 * ribbon's dialog launchers, "More Number Formats...", "More Borders...") and
 * `{ category }` -- a Number-tab category, which is how the Accounting split
 * button's "More Accounting Formats..." opens on Accounting as Excel's does. A
 * category alone implies the Number tab, the only tab with categories.
 */
function requestedView(args: unknown): { tab: string; category?: string } | null {
  const tab = stringArg(args, "tab");
  const category = stringArg(args, "category");
  if (category !== null) return { tab: tab ?? "number", category };
  return tab !== null ? { tab } : null;
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
  // through here. It asks WHICH cells (P3): Core's selection, or a floating
  // grid's own cells when its owner admits "format" -- the dialog then seeds
  // from and writes to those (FormatCellsDialog.tsx, lib/formatCellsWrites.ts).
  // While an owner that does not admit it holds the selection (BUG-0185) it
  // does not open at all. The two "More"
  // rows opened the dialog directly, past this check, until the review of
  // BUG-0185; they now pass `{ tab }`, which opens it on that tab, and
  // optionally `{ category }` for the Number tab's category list.
  context.commands.register(CoreCommands.FORMAT_CELLS, (args?: unknown) => {
    if (resolveCellTarget("Format Cells", "format") === null) return;
    const view = requestedView(args);
    if (view === null) DialogExtensions.openDialog("format-cells");
    else DialogExtensions.openDialog("format-cells", view);
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
