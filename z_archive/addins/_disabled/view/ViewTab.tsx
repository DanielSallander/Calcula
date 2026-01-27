//! FILENAME: z_archive/addins/_disabled/view/ViewTab.tsx
// PURPOSE: View tab placeholder.

import React from "react";
import type { RibbonContext } from "../../../core/extensions/types";
import { placeholderStyles } from "../../../shell/Ribbon/styles/styles";

interface ViewTabProps {
  context: RibbonContext;
}

export function ViewTab({ context }: ViewTabProps): React.ReactElement {
  return (
    <div style={placeholderStyles}>
      View tab - Coming soon
    </div>
  );
}