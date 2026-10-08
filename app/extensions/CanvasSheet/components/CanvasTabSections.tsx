//! FILENAME: app/extensions/CanvasSheet/components/CanvasTabSections.tsx
// PURPOSE: The contextual "Canvas" ribbon tab -- Power BI Desktop's report
//          authoring on one tab (owner decision 2026-10-08, CONTRACT-CANVAS):
//          shown while a canvas sheet is active, left to right
//            Pages     New Page                    (./CanvasPagesSection.tsx)
//            Visuals   the pane's two rows + All Visuals (./CanvasVisualsSection.tsx)
//            Elements  Text Box, Buttons v, Shapes v, Image, Floating Grid
//                                                  (./CanvasElementsSection.tsx)
//            Arrange   stacking, align/distribute, lock, Size & Position
//                                                  (./CanvasArrangeSection.tsx)
//            Page      Page Size v, Page Background, Wallpaper, Themes v
//                                                  (./CanvasPageSection.tsx)
//            View      Page View v, gridlines/snap/Lock Objects/grid size,
//                      Design Mode                 (./CanvasViewSection.tsx)
// CONTEXT: Composed from @api/layout primitives only (no CSS, no colours), so
//          it follows every skin and renders in the band, a launcher flyout or
//          the sidebar from one tree. Every group fills the band's 61px box in
//          one of the two sanctioned ways (docs/design/ribbon-design-system.md):
//          a tall row of heroes, or two 28px rows -- or both side by side.
//
//          FOLDING. A LOWER collapsePriority folds into its launcher FIRST
//          (app/src/api/uiTypes.ts), so on a narrow window View goes first and
//          Pages last -- the contract's order: what a report author reaches
//          for most (a new page, a visual) stays on the band longest.
//
//          E2E contract: the contextual TAB is the only button whose text is
//          exactly "Canvas", so no control in this tab is labelled "Canvas".

import React from "react";
import type { PanelDefinition } from "@api/uiTypes";
import { ICON_SIZE_MD, ICON_SIZE_SM } from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { CanvasPagesSection } from "./CanvasPagesSection";
import { CanvasVisualsSection } from "./CanvasVisualsSection";
import { CanvasElementsSection } from "./CanvasElementsSection";
import { CanvasArrangeSection } from "./CanvasArrangeSection";
import { CanvasPageSection } from "./CanvasPageSection";
import { CanvasViewSection } from "./CanvasViewSection";

export { CanvasPagesSection } from "./CanvasPagesSection";
export { CanvasVisualsSection } from "./CanvasVisualsSection";
export { CanvasElementsSection } from "./CanvasElementsSection";
export { CanvasArrangeSection } from "./CanvasArrangeSection";
export { CanvasPageSection } from "./CanvasPageSection";
export { CanvasViewSection } from "./CanvasViewSection";

export const CANVAS_TAB_ID = "canvas-sheet-tab";

/** The tab's accent: the skin's canvas token, with the light fallback. */
export const CANVAS_TAB_COLOR = "var(--tab-accent-canvas, #b0245f)";

export const CanvasPanelDefinition: PanelDefinition = {
  id: CANVAS_TAB_ID,
  title: "Canvas",
  // A report page (a page with a chart): the tab is about report pages.
  icon: <RibbonIcon.Report size={ICON_SIZE_SM} />,
  sections: [
    {
      id: "canvas-tab.pages",
      label: "Pages",
      icon: <RibbonIcon.NewPage size={ICON_SIZE_MD} />,
      component: CanvasPagesSection,
      ribbonPresentation: "inline",
      collapsePriority: 6,
    },
    {
      id: "canvas-tab.visuals",
      label: "Visuals",
      // Not AllVisuals: that picture is drawn for its 30px hero only, and a
      // folded group's launcher shows its icon small (ICONS.md section 4).
      icon: <RibbonIcon.ChartColumn size={ICON_SIZE_MD} />,
      component: CanvasVisualsSection,
      ribbonPresentation: "inline",
      collapsePriority: 5,
    },
    {
      id: "canvas-tab.elements",
      label: "Elements",
      icon: <RibbonIcon.Shapes size={ICON_SIZE_MD} />,
      component: CanvasElementsSection,
      ribbonPresentation: "inline",
      collapsePriority: 4,
    },
    {
      id: "canvas-tab.arrange",
      label: "Arrange",
      icon: <RibbonIcon.BringForward size={ICON_SIZE_MD} />,
      component: CanvasArrangeSection,
      // Five heroes (three menus, a toggle and Size & Position): one tall row.
      ribbonPresentation: "inline",
      collapsePriority: 3,
    },
    {
      id: "canvas-tab.page",
      label: "Page",
      icon: <RibbonIcon.PageSize size={ICON_SIZE_MD} />,
      component: CanvasPageSection,
      ribbonPresentation: "inline",
      collapsePriority: 2,
    },
    {
      id: "canvas-tab.view",
      label: "View",
      icon: <RibbonIcon.FitToPage size={ICON_SIZE_MD} />,
      component: CanvasViewSection,
      ribbonPresentation: "inline",
      collapsePriority: 1,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 505,
  ribbonColor: CANVAS_TAB_COLOR,
  // Navigating to a canvas brings its tab forward, and leaving puts the tab
  // the user had back (RibbonContainer's activate-on-register rule).
  ribbonActivateOnRegister: true,
  priority: 1000 - 505,
};
