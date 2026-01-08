// FILENAME: app/src/components/Ribbon/tabs/InsertTab/InsertTab.tsx
// PURPOSE: Insert tab placeholder.

import React from "react";
import type { RibbonContext } from "../../../core/extensions/types";
import { placeholderStyles } from "../../../shell/Ribbon/styles/styles";

interface InsertTabProps {
  context: RibbonContext;
}

export function InsertTab({ context }: InsertTabProps): React.ReactElement {
  return (
    <div style={placeholderStyles}>
      Insert tab - Coming soon
    </div>
  );
}