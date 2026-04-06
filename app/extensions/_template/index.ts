//! FILENAME: app/extensions/_template/index.ts
// PURPOSE: Template extension — copy this folder to start a new extension.
// USAGE: 1. Copy _template/ to MyExtension/
//        2. Update manifest (id, name, description)
//        3. Add your logic in activate()
//        4. Register in extensions/manifest.ts

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerMenuItem,
  onAppEvent,
  AppEvents,
  showToast,
} from "@api";

// ============================================================================
// State
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[_template] Activating...");

  // --- Example: Register a menu item ---
  registerMenuItem("view", {
    id: "template.hello",
    label: "Hello from Template",
    action: () => {
      showToast("Hello from the template extension!", { type: "info" });
    },
  });

  // --- Example: Listen to selection changes ---
  const unsub = onAppEvent(AppEvents.SELECTION_CHANGED, () => {
    // React to selection changes here
  });
  cleanupFns.push(unsub);

  // --- Example: Register a command ---
  context.commands.register("template.greet", () => {
    showToast("Greetings from the template command!");
  });

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
