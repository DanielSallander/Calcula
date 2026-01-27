//! FILENAME: app/src/shell/Ribbon/components/RibbonSeparator.tsx
// PURPOSE: Visual separator between ribbon groups.

import React from "react";
import { groupSeparatorStyles } from "../styles/styles";

/**
 * Vertical separator between ribbon groups.
 */
export function RibbonSeparator(): React.ReactElement {
  return <div style={groupSeparatorStyles} />;
}