//! FILENAME: app/extensions/Sparklines/manifest.ts
// PURPOSE: Sparkline extension manifest and contextual panel definition.
// CONTEXT: Defines the contextual "Sparkline" design panel (ribbon-placed by
//          default) that appears when the user selects a cell containing a
//          sparkline. One PanelSection per former ribbon group; the shell
//          owns group chrome, labels, and width-pressure collapse
//          (collapsePriority: lower collapses to a launcher first).

import type { PanelDefinition } from "@api/uiTypes";
import {
  SparklineEditSection,
  SparklineTypeSection,
  SparklineShowSection,
  SparklineStyleSection,
  SparklineAxisSection,
  SparklineGroupSection,
} from "./components/SparklineDesignSections";

// ============================================================================
// Contextual Panel (formerly the contextual ribbon tab)
// ============================================================================

export const SPARKLINE_DESIGN_TAB_ID = "sparkline-design";

/** Former ribbon-tab order; also derives the panel priority. */
const SPARKLINE_DESIGN_TAB_ORDER = 510;

export const SparklineDesignPanelDefinition: PanelDefinition = {
  id: SPARKLINE_DESIGN_TAB_ID,
  title: "Sparkline",
  icon: null,
  sections: [
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.sparkline`,
      label: "Sparkline",
      icon: "✎",
      component: SparklineEditSection,
      collapsePriority: 1,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.type`,
      label: "Type",
      icon: "─",
      component: SparklineTypeSection,
      collapsePriority: 2,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.show`,
      label: "Show",
      icon: "☑",
      component: SparklineShowSection,
      collapsePriority: 3,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.style`,
      label: "Style",
      icon: "✨",
      component: SparklineStyleSection,
      // Band-designed widgets (preset strip + color-picker popovers): trusted
      // band-native content, never height-probed.
      ribbonPresentation: "inline",
      collapsePriority: 4,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.axis`,
      label: "Axis",
      icon: "┃",
      component: SparklineAxisSection,
      collapsePriority: 6,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.group`,
      label: "Group",
      icon: "⊞",
      component: SparklineGroupSection,
      collapsePriority: 5,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: SPARKLINE_DESIGN_TAB_ORDER,
  priority: 1000 - SPARKLINE_DESIGN_TAB_ORDER,
};
