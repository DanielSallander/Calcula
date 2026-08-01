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
import { subscribeToExtensionContributions, listExtensionRibbonButtons } from "@api/scriptHost/extensionWorkerHost";
import { ExtensionsListView } from "./ExtensionsListView";
import { AddInsRibbonSection } from "./AddInsRibbonSection";
import { extensionsBackend } from "./backendChannel";

const cleanupFns: Array<() => void> = [];

const ADDINS_PANEL_ID = "extensions.addins";

/** Puzzle-piece glyph reused for the Add-ins ribbon tab. */
const AddInsIcon = React.createElement(
  "svg",
  {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  React.createElement("path", {
    d: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z",
  }),
);

/** SVG puzzle piece icon for the Activity Bar */
const ExtensionsIcon = React.createElement(
  "svg",
  {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  React.createElement("path", {
    d: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z",
  })
);

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

  // Keyboard shortcut: Ctrl+Shift+X
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "X") {
      e.preventDefault();
      context.ui.activityBar.toggle("extensions");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // The "Add-ins" ribbon tab. Registered lazily and re-registered when the set
  // of contributions changes, so an install with no ribbon buttons never adds an
  // empty tab to the band — and the first add-in that contributes one makes the
  // tab appear without a reload.
  let addInsRegistered = false;
  const syncAddInsTab = (): void => {
    const wanted = listExtensionRibbonButtons().length > 0;
    if (wanted === addInsRegistered) return;
    if (wanted) {
      context.ui.panels.register({
        id: ADDINS_PANEL_ID,
        title: "Add-ins",
        icon: AddInsIcon,
        sections: [
          {
            id: "extensions.addins.buttons",
            label: "Add-ins",
            component: AddInsRibbonSection,
            ribbonPresentation: "inline",
          },
        ],
        defaultPlacement: "ribbon",
        supportedPlacements: ["ribbon", "sidebar"],
        ribbonOrder: 90,
      });
    } else {
      context.ui.panels.unregister(ADDINS_PANEL_ID);
    }
    addInsRegistered = wanted;
  };
  syncAddInsTab();
  cleanupFns.push(subscribeToExtensionContributions(syncAddInsTab));
  cleanupFns.push(() => {
    if (addInsRegistered) {
      context.ui.panels.unregister(ADDINS_PANEL_ID);
      addInsRegistered = false;
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
