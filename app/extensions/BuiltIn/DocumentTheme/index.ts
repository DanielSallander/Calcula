//! FILENAME: app/extensions/BuiltIn/DocumentTheme/index.ts
//! PURPOSE: Document Theme extension - Page Layout ribbon tab with theme management.
//! CONTEXT: Provides theme gallery, theme color/font pickers.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { ExtensionRegistry } from "../../../src/api/extensions";
import { AppEvents, onAppEvent } from "../../../src/api/events";
import { markSheetDirty } from "../../../src/api/styleInterceptors";
import { PageLayoutTab } from "./components/PageLayoutTab";

const PAGE_LAYOUT_TAB_ID = "page-layout";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

function activate(_context: ExtensionContext): void {
  if (isActivated) return;

  // Register the Page Layout ribbon tab
  ExtensionRegistry.registerRibbonTab({
    id: PAGE_LAYOUT_TAB_ID,
    label: "Page Layout",
    order: 30,
    component: PageLayoutTab,
  });

  // Listen for theme changes and trigger re-render
  const unsubTheme = onAppEvent(AppEvents.THEME_CHANGED, () => {
    markSheetDirty();
  });
  cleanupFns.push(unsubTheme);

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;

  ExtensionRegistry.unregisterRibbonTab(PAGE_LAYOUT_TAB_ID);

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
