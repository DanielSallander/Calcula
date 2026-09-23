//! FILENAME: app/extensions/BuiltIn/DocumentTheme/index.ts
//! PURPOSE: Document Theme extension - Page Layout panel with theme management.
//! CONTEXT: Provides the theme gallery and the theme font picker. Registers a
//!          location-agnostic panel (ribbon-placed by default) via the panel
//!          system; the shell renders its section as a ribbon cluster or a
//!          sidebar block automatically.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { registerPanel, unregisterPanel } from "@api/ui";
import { AppEvents, onAppEvent } from "@api/events";
import { markSheetDirty } from "@api/styleInterceptors";
import { ICON_SIZE_MD, ICON_SIZE_SM } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { ThemesSection } from "./components/ThemesSection";

const PAGE_LAYOUT_PANEL_ID = "page-layout";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

function activate(_context: ExtensionContext): void {
  if (isActivated) return;

  // Register the Page Layout panel. One section per former ribbon group:
  // "Themes" hosts the Themes + Fonts heroes and their card popovers.
  registerPanel({
    id: PAGE_LAYOUT_PANEL_ID,
    title: "Page Layout",
    // Rail icon when moved to the sidebar, and the lone launcher's icon when
    // the single section is fully demoted in a narrow band.
    icon: React.createElement(RibbonIcon.Layout, { size: ICON_SIZE_SM }),
    sections: [
      {
        id: "page-layout.themes",
        label: "Themes",
        icon: React.createElement(RibbonIcon.Theme, { size: ICON_SIZE_MD }),
        component: ThemesSection,
        // Two 61px heroes: one tall row that fills the cluster's content box
        // exactly, so trust it inline and skip the shell's height probe.
        ribbonPresentation: "inline",
      },
    ],
    defaultPlacement: "ribbon",
    ribbonOrder: 30,
    priority: 970, // 1000 - ribbonOrder
  });

  // Listen for theme changes and trigger re-render
  const unsubTheme = onAppEvent(AppEvents.THEME_CHANGED, () => {
    markSheetDirty();
    // Refresh the style cache so resolved font families update immediately
    window.dispatchEvent(new CustomEvent("styles:refresh"));
  });
  cleanupFns.push(unsubTheme);

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;

  unregisterPanel(PAGE_LAYOUT_PANEL_ID);

  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error(err); }
  }
  cleanupFns.length = 0;

  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.document-theme",
    name: "Document Theme",
    version: "1.0.0",
    description: "Excel-compatible document themes (colors, fonts, effects)",
  },
  activate,
  deactivate,
};

export default extension;
