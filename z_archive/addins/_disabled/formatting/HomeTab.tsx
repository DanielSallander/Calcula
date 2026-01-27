//! FILENAME: z_archive/addins/_disabled/formatting/HomeTab.tsx
// PURPOSE: Home tab content component.
// CONTEXT: Contains Clipboard, Font, Alignment, and Number format groups.

import React from "react";
import type { RibbonContext } from "../../../core/extensions/types";
import { RibbonGroup, RibbonSeparator } from "../../../shell/Ribbon/components";
import { ClipboardGroup } from "./font/ClipboardGroup";
import { FontGroup } from "./font/FontGroup";
import { AlignmentGroup } from "./alignment/AlignmentGroup";
import { NumberGroup } from "./number/NumberGroup";
import { groupContainerStyles } from "../../../shell/Ribbon/styles/styles";

interface HomeTabProps {
  context: RibbonContext;
}

/**
 * Home tab content.
 * Renders Clipboard, Font, Alignment, and Number groups.
 */
export function HomeTab({ context }: HomeTabProps): React.ReactElement {
  return (
    <div style={groupContainerStyles}>
      <RibbonGroup title="Clipboard">
        <ClipboardGroup context={context} />
      </RibbonGroup>

      <RibbonSeparator />

      <RibbonGroup title="Font">
        <FontGroup context={context} />
      </RibbonGroup>

      <RibbonSeparator />

      <RibbonGroup title="Alignment">
        <AlignmentGroup context={context} />
      </RibbonGroup>

      <RibbonSeparator />

      <RibbonGroup title="Number">
        <NumberGroup context={context} />
      </RibbonGroup>
    </div>
  );
}