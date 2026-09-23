//! FILENAME: app/extensions/_template/index.ts
// PURPOSE: Template extension — copy this folder to start a new extension.
// USAGE: 1. Copy _template/ to MyExtension/
//        2. Update manifest (id, name, description)
//        3. Add your logic in activate()
//        4. Register in extensions/manifest.ts
// CONTEXT: Shows the four registrations almost every extension makes: a menu
//          item, an event listener, a command, and a ribbon tab / sidebar
//          panel built from @api/layout (components/MyRibbonSections.tsx —
//          read its header for the fill rule and the control grammar, and
//          components/templatePanel.tsx for the panel declaration).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerMenuItem,
  unregisterMenuItem,
  onAppEvent,
  AppEvents,
  showToast,
} from "@api";
import { TEMPLATE_RUN_COMMAND } from "./components/MyRibbonSections";
import { buildTemplatePanelDefinition, TEMPLATE_PANEL_ID } from "./components/templatePanel";
import {
  describeTemplateRun,
  getTemplateOptions,
  resetTemplateOptions,
} from "./lib/templateOptions";

// ============================================================================
// State
// ============================================================================

const cleanupFns: (() => void)[] = [];

const GREET_COMMAND = "template.greet";
const HELLO_MENU_ITEM = "template.hello";

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[_template] Activating...");

  // --- Example: Register a menu item ---
  registerMenuItem("view", {
    id: HELLO_MENU_ITEM,
    label: "Hello from Template",
    action: () => {
      showToast("Hello from the template extension!", { type: "info" });
    },
  });
  cleanupFns.push(() => unregisterMenuItem("view", HELLO_MENU_ITEM));

  // --- Example: Listen to selection changes ---
  const unsub = onAppEvent(AppEvents.SELECTION_CHANGED, () => {
    // React to selection changes here
  });
  cleanupFns.push(unsub);

  // --- Example: Register a command ---
  context.commands.register(GREET_COMMAND, () => {
    showToast("Greetings from the template command!");
  });
  cleanupFns.push(() => context.commands.unregister(GREET_COMMAND));

  // --- Example: A ribbon tab that can also live in the sidebar ---
  // The Run hero executes this command, so the same action is reachable from
  // a keybinding or a menu item too. Register the command BEFORE the panel,
  // so the button never exists without the command it runs.
  context.commands.register(TEMPLATE_RUN_COMMAND, () => {
    showToast(describeTemplateRun(getTemplateOptions()), { type: "info" });
  });
  cleanupFns.push(() => context.commands.unregister(TEMPLATE_RUN_COMMAND));

  // One registration; the shell decides where it renders (ribbon by default,
  // sidebar if the user moves it) and lays the sections out for that surface.
  context.ui.panels.register(buildTemplatePanelDefinition());
  cleanupFns.push(() => context.ui.panels.unregister(TEMPLATE_PANEL_ID));

  // Module state must not outlive the extension: a re-activation starts from
  // the defaults, not from whatever the last session left behind.
  cleanupFns.push(resetTemplateOptions);

  console.log("[_template] Activated successfully.");
}

function deactivate(): void {
  console.log("[_template] Deactivating...");

  // Clean up in reverse order
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (error) {
      console.error("[_template] Error during cleanup:", error);
    }
  }
  cleanupFns.length = 0;

  console.log("[_template] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "my-org.my-extension",          // TODO: Change to your unique ID
    name: "My Extension",               // TODO: Change to your extension name
    version: "1.0.0",
    apiVersion: "^1.0.0",
    description: "A template extension. Replace this description.",
  },
  activate,
  deactivate,
};

export default extension;
