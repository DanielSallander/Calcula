//! FILENAME: app/extensions/BuiltIn/FormatPainter/index.ts
// PURPOSE: Format Painter extension module entry point.
// CONTEXT: Registers commands, keyboard shortcuts, and menu items for the Format Painter tool.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { CoreCommands } from "../../../src/api/commands";
import { ExtensionRegistry } from "../../../src/api/extensions";
import { registerMenuItem } from "../../../src/api/ui";
import { activateFormatPainter, deactivateFormatPainter } from "./formatPainterLogic";
import { isFormatPainterActive } from "./formatPainterState";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
let currentSelection: { startRow: number; startCol: number; endRow: number; endCol: number; type: string } | null = null;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[FormatPainterExtension] Already activated, skipping.");
    return;
  }

  console.log("[FormatPainterExtension] Activating...");

  // Track current selection so we know the source when the command fires
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    if (!isFormatPainterActive()) {
      currentSelection = sel;
    }
  });
  cleanupFns.push(unsubSelection);

  // Register Format Painter command (single-use mode)
  context.commands.register(CoreCommands.FORMAT_PAINTER, async () => {
    await activateFormatPainter(false, currentSelection);
  });

  // Register Format Painter Lock command (persistent mode)
  context.commands.register(CoreCommands.FORMAT_PAINTER_LOCK, async () => {
    await activateFormatPainter(true, currentSelection);
  });

  // Register keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+Shift+C: Activate Format Painter (single-use)
    if (e.ctrlKey && e.shiftKey && e.key === "C") {
      e.preventDefault();
      context.commands.execute(CoreCommands.FORMAT_PAINTER);
      return;
    }

    // ESC: Deactivate Format Painter (if active)
    if (e.key === "Escape" && isFormatPainterActive()) {
      e.preventDefault();
      e.stopPropagation();
      deactivateFormatPainter();
    }
  };
  // Use capture phase so ESC is handled before grid keyboard handlers
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // Register menu items in Edit menu (separator + format painter with submenu)
  registerMenuItem("edit", {
    id: "edit:sep-fp",
    label: "",
    separator: true,
  });
  registerMenuItem("edit", {
    id: "edit:formatPainter",
    label: "Format Painter",
    shortcut: "Ctrl+Shift+C",
    commandId: CoreCommands.FORMAT_PAINTER,
    action: () => context.commands.execute(CoreCommands.FORMAT_PAINTER),
    children: [
      {
        id: "edit:formatPainterLock",
        label: "Format Painter Lock",
        action: () => context.commands.execute(CoreCommands.FORMAT_PAINTER_LOCK),
      },
    ],
  });

  isActivated = true;
  console.log("[FormatPainterExtension] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[FormatPainterExtension] Deactivating...");

  // Deactivate painter if active
  if (isFormatPainterActive()) {
    deactivateFormatPainter();
  }

  // Run all cleanup functions
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[FormatPainterExtension] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log("[FormatPainterExtension] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.format-painter",
    name: "Format Painter",
    version: "1.0.0",
    description: "Copy formatting from one cell/range and apply it to another.",
  },
  activate,
  deactivate,
};

export default extension;
