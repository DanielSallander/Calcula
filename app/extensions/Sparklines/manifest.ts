//! FILENAME: app/extensions/Sparklines/manifest.ts
// PURPOSE: Sparkline extension manifest and ribbon tab definition.
// CONTEXT: Defines the contextual "Sparkline" ribbon tab that appears
//          when the user selects a cell containing a sparkline.

import { SparklineDesignTab } from "./components/SparklineDesignTab";

// ============================================================================
// Contextual Ribbon Tab
// ============================================================================

export const SPARKLINE_DESIGN_TAB_ID = "sparkline-design";

export const SparklineDesignTabDefinition = {
  id: SPARKLINE_DESIGN_TAB_ID,
  label: "Sparkline",
  order: 510,
  component: SparklineDesignTab,
};
