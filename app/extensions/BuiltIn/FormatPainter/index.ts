//! FILENAME: app/extensions/BuiltIn/FormatPainter/index.ts
// PURPOSE: Format Painter extension module entry point.
// CONTEXT: Registers commands, keyboard shortcuts, and menu items for the Format Painter tool.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import type { Selection } from "@api";
import { CoreCommands } from "@api/commands";
import { ExtensionRegistry, IconFormatPainter, IconLock } from "@api";
import { registerMenuItem, unregisterMenuItem } from "@api/ui";
import { activateFormatPainter, deactivateFormatPainter } from "./formatPainterLogic";
import { isFormatPainterActive } from "./formatPainterState";

// ============================================================================
// Extension State
// ============================================================================

let isActivated = false;
let currentSelection: Selection | null = null;
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
  // Deactivate takes both away: a deactivated extension must not keep
  // answering the registry's Ctrl+Shift+C (D3 class).
  cleanupFns.push(() => context.commands.unregister(CoreCommands.FORMAT_PAINTER));
  cleanupFns.push(() => context.commands.unregister(CoreCommands.FORMAT_PAINTER_LOCK));

  // Keyboard. Ctrl+Shift+C is NOT handled here: the keybinding registry's
  // `core.formatPainter` binding runs FORMAT_PAINTER ("not-editing", so never
  // in a text field, a claim or a cell edit). This listener used to run the
  // same command beside it, so one keystroke with the grid focused started the
  // painter twice, and a user's remap in Settings left Ctrl+Shift+C working
  // (BUG-0199). Only Escape is the painter's own key.
  const handleKeyDown = (e: KeyboardEvent) => {
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
  // Both items go on deactivate, like the commands: an item outliving the
  // extension ran a command that no longer existed (D3 review).
  registerMenuItem("edit", {
    id: "edit:sep-fp",
    label: "",
    separator: true,
  });
  cleanupFns.push(() => unregisterMenuItem("edit", "edit:sep-fp"));
  registerMenuItem("edit", {
    id: "edit:formatPainter",
    label: "Format Painter",
    icon: IconFormatPainter,
    shortcut: "Ctrl+Shift+C",
    commandId: CoreCommands.FORMAT_PAINTER,
    action: () => context.commands.execute(CoreCommands.FORMAT_PAINTER),
    children: [
      {
        id: "edit:formatPainterLock",
        label: "Format Painter Lock",
        icon: IconLock,
        action: () => context.commands.execute(CoreCommands.FORMAT_PAINTER_LOCK),
      },
    ],
  });
  cleanupFns.push(() => unregisterMenuItem("edit", "edit:formatPainter"));

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
