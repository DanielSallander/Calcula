//! FILENAME: app/extensions/Sparklines/manifest.ts
// PURPOSE: Sparkline extension manifest and contextual panel definition.
// CONTEXT: Defines the contextual "Sparkline" design panel (ribbon-placed by
//          default) that appears when the user selects a cell containing a
//          sparkline. One PanelSection per former ribbon group; the shell
//          owns group chrome, labels, and width-pressure collapse
//          (collapsePriority: lower collapses to a launcher first).
//
//          Icons come from the one duotone set (RibbonIcon): 24px for a
//          section (the launcher slot when a section demotes), 20px for the
//          panel (the activity-bar / tab icon). The tab accent is a token so a
//          skin can recolour it; the literal is only the fallback.

import React from "react";
import type { PanelDefinition } from "@api/uiTypes";
import { RibbonIcon } from "@api/ribbonIcons";
import { ICON_SIZE_MD, ICON_SIZE_SM } from "@api/layout";
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

/** Contextual-tab accent: the skin's sparkline accent, fallback for no skin. */
const SPARKLINE_TAB_COLOR = "var(--tab-accent-sparkline, #c2410c)";

/** A section icon: 24px, the size the launcher slot shows. */
function sectionIcon(icon: React.ComponentType<{ size?: number }>): React.ReactElement {
  return React.createElement(icon, { size: ICON_SIZE_MD });
}

export const SparklineDesignPanelDefinition: PanelDefinition = {
  id: SPARKLINE_DESIGN_TAB_ID,
  title: "Sparkline",
  icon: React.createElement(RibbonIcon.Sparkline, { size: ICON_SIZE_SM }),
  sections: [
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.sparkline`,
      label: "Sparkline",
      icon: sectionIcon(RibbonIcon.Pencil),
      component: SparklineEditSection,
      collapsePriority: 1,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.type`,
      label: "Type",
      icon: sectionIcon(RibbonIcon.SparkLine),
      component: SparklineTypeSection,
      collapsePriority: 2,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.show`,
      label: "Show",
      icon: sectionIcon(RibbonIcon.Markers),
      component: SparklineShowSection,
      collapsePriority: 3,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.style`,
      label: "Style",
      icon: sectionIcon(RibbonIcon.Palette),
      component: SparklineStyleSection,
      // Two known 28px rows (preset strip over the colour pickers; both open
      // body-portalled popovers): trusted band-native content, never
      // height-probed.
      ribbonPresentation: "inline",
      collapsePriority: 4,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.axis`,
      label: "Axis",
      icon: sectionIcon(RibbonIcon.AxisLabels),
      component: SparklineAxisSection,
      collapsePriority: 6,
    },
    {
      id: `${SPARKLINE_DESIGN_TAB_ID}.group`,
      label: "Group",
      icon: sectionIcon(RibbonIcon.Group),
      component: SparklineGroupSection,
      collapsePriority: 5,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: SPARKLINE_DESIGN_TAB_ORDER,
  ribbonColor: SPARKLINE_TAB_COLOR,
  priority: 1000 - SPARKLINE_DESIGN_TAB_ORDER,
};
