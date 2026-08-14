//! FILENAME: app/extensions/CommandLine/index.ts
// PURPOSE: The main-window Command Line extension — hosts the fused Calcula
//          CLI (shared kernel + the APP domain) in a bottom-docked panel.
//          Ctrl+Shift+P toggles it (Ctrl+` is Show Formulas, Excel parity);
//          also reachable from View > Command Line.
// CONTEXT: The CLI is TRUSTED UI — the same privilege as a menu click. It is
//          deliberately unreachable from sandboxed scripts: the engine is not
//          exported via @api, and the toggle command is NOT scriptSafe.
//          Design: docs/design/macro-model-recording-and-fused-cli.md.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerMenuItem, unregisterMenuItem } from "@api";
import { registerKeybinding } from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { AppCliPanel, toggleAppCliPanel } from "./components/AppCliPanel";

const TOGGLE_COMMAND = "commandLine.toggle";
const MENU_ITEM_ID = "command-line-toggle";
const DIALOG_ID = "command-line-panel";

const cleanupFns: Array<() => void> = [];

function activate(context: ExtensionContext): void {
  // The panel is registered through the dialog service (WatchWindow
  // precedent) but renders as a bottom-docked strip, not a floating window.
  context.ui.dialogs.register({
    id: DIALOG_ID,
    component: AppCliPanel,
    priority: 60,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(DIALOG_ID));

  // Deliberately NOT scriptSafe: a sandboxed script must never be able to
  // open a trusted text-dispatch surface.
  CommandRegistry.register(TOGGLE_COMMAND, () => toggleAppCliPanel());
  cleanupFns.push(() => CommandRegistry.unregister(TOGGLE_COMMAND));

  cleanupFns.push(
    registerKeybinding({
      id: "ext.commandLine.toggle",
      combo: "Ctrl+Shift+P",
      commandId: TOGGLE_COMMAND,
      label: "Command Line",
      category: "Navigation",
      context: "not-editing",
      source: "extension",
      extensionId: "calcula.command-line",
    }),
  );

  // commandId, not action: dispatching through the registry keeps the toggle
  // visible to the command palette and the macro recorder's command hook.
  registerMenuItem("view", {
    id: MENU_ITEM_ID,
    label: "Command Line",
    shortcut: "Ctrl+Shift+P",
    commandId: TOGGLE_COMMAND,
  });
  cleanupFns.push(() => unregisterMenuItem("view", MENU_ITEM_ID));
}

function deactivate(): void {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[CommandLine] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.command-line",
    name: "Command Line",
    version: "1.0.0",
    description:
      "A command line for the workbook — sheets, cells, names, sorting and macros, sharing one grammar with the Model Editor CLI.",
  },
  activate,
  deactivate,
};
export default extension;
