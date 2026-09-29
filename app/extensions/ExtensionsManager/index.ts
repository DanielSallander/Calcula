//! FILENAME: app/extensions/ExtensionsManager/index.ts
// PURPOSE: Extensions Manager extension - registers an Activity Bar view for
//          managing extensions, plus the host-rendered "Add-ins" ribbon tab that
//          paints sandboxed third-party extensions' declarative contributions.
// CONTEXT: Lists all loaded extensions with status badges, their declared and
//          installed contributions, and any contribution the host REFUSED.
//          The Add-ins tab is the "host-owned chrome, extension-owned content"
//          half of docs/design/third-party-addin-authoring.md: a sandboxed
//          extension ships descriptors, this trusted built-in renders them.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { subscribeToExtensionContributions } from "@api/scriptHost/extensionWorkerHost";
import { ICON_SIZE_MD, ICON_SIZE_SM } from "@api/layout";
import { ExtensionsListView } from "./ExtensionsListView";
import {
  AddInGlyph,
  addInSectionsKey,
  buildAddInsSections,
  computeAddInGroups,
} from "./AddInsRibbonSection";
import { extensionsBackend } from "./backendChannel";

const cleanupFns: Array<() => void> = [];

const ADDINS_PANEL_ID = "extensions.addins";

/**
 * Toggle the Extensions panel -- the command the keybinding registry's
 * `ext.extensionsManager.toggle` (Ctrl+Shift+X) runs. The registry named this
 * id long before anything registered it; the key worked only through a window
 * listener here, which a remap in Settings could not move (BUG-0183 class).
 */
export const EXTENSIONS_MANAGER_TOGGLE_COMMAND = "extensionsManager.toggle";

/** The host's add-in glyph, as the Add-ins tab / rail icon (20px). */
const AddInsIcon = React.createElement(AddInGlyph, { size: ICON_SIZE_SM });

/** The same glyph for the Extensions view on the Activity Bar (24px). */
const ExtensionsIcon = React.createElement(AddInGlyph, { size: ICON_SIZE_MD });

function activate(context: ExtensionContext): void {
  // Bind the capability-gated backend door BEFORE any view can mount: the
  // install dialog is a React component and never receives `ctx`, so this is
  // the only route by which its `install_extension` call reaches the trust gate
  // (A3 — extensions must not hold the raw invokeBackend passthrough).
  extensionsBackend.set(context.invokeBackend);

  context.ui.activityBar.register({
    id: "extensions",
    title: "Extensions",
    icon: ExtensionsIcon,
    component: ExtensionsListView,
    priority: 10,
    bottom: true,
  });
  cleanupFns.push(() => context.ui.activityBar.unregister("extensions"));

  // The command the registry's Ctrl+Shift+X runs (the one keyboard path).
  context.commands.register(EXTENSIONS_MANAGER_TOGGLE_COMMAND, () => context.ui.activityBar.toggle("extensions"));
  cleanupFns.push(() => context.commands.unregister(EXTENSIONS_MANAGER_TOGGLE_COMMAND));

  // The "Add-ins" ribbon tab. Registered lazily and re-registered when the set
  // of contribution GROUPS changes, so an install with no ribbon buttons never
  // adds an empty tab to the band — and the first add-in that contributes one
  // makes the tab appear without a reload. Each group is its own section (one
  // cluster each, attribution as its always-shown caption), so add-in groups
  // demote one at a time in a narrow band like built-in clusters do. Buttons
  // changing inside an existing group re-render through the section's own
  // store subscription and need no re-registration.
  let registeredKey: string | null = null;
  const syncAddInsTab = (): void => {
    const groups = computeAddInGroups();
    const key = addInSectionsKey(groups);
    if (key === registeredKey) return;
    if (key !== null) {
      context.ui.panels.register({
        id: ADDINS_PANEL_ID,
        title: "Add-ins",
        icon: AddInsIcon,
        sections: buildAddInsSections(groups),
        defaultPlacement: "ribbon",
        supportedPlacements: ["ribbon", "sidebar"],
        ribbonOrder: 90,
      });
    } else {
      context.ui.panels.unregister(ADDINS_PANEL_ID);
    }
    registeredKey = key;
  };
  syncAddInsTab();
  cleanupFns.push(subscribeToExtensionContributions(syncAddInsTab));
  cleanupFns.push(() => {
    if (registeredKey !== null) {
      context.ui.panels.unregister(ADDINS_PANEL_ID);
      registeredKey = null;
    }
  });

  console.log("[ExtensionsManager] Extension activated");
}

function deactivate(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[ExtensionsManager] Extension deactivated");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.extensions-manager",
    name: "Extensions Manager",
    version: "1.0.0",
    description: "Activity Bar panel for managing loaded extensions",
  },
  activate,
  deactivate,
};

export default extension;
