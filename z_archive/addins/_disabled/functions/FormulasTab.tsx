//! FILENAME: z_archive/addins/_disabled/functions/FormulasTab.tsx
// PURPOSE: Formulas tab content component.
// CONTEXT: Contains Function Library and Calculation groups.

import React, { useCallback } from "react";
import type { RibbonContext } from "../../../core/extensions/types";
import { RibbonGroup, RibbonSeparator } from "../../../shell/Ribbon/components";
import { FunctionLibraryGroup } from "./library/FunctionLibraryGroup";
import { CalculationGroup } from "./calculation/CalculationGroup";
import { groupContainerStyles } from "../../../shell/Ribbon/styles/styles";

interface FormulasTabProps {
  context: RibbonContext;
}

/**
 * Formulas tab content.
 * Renders Function Library and Calculation groups.
 */
export function FormulasTab({ context }: FormulasTabProps): React.ReactElement {
  // Close all dropdowns when clicking on the container
  const handleContainerClick = useCallback(() => {
    // Dropdowns handle their own closing via click-outside detection
  }, []);

  return (
    <div style={groupContainerStyles} onClick={handleContainerClick}>
      <RibbonGroup title="Function Library" style={{ minWidth: "480px" }}>
        <FunctionLibraryGroup context={context} />
      </RibbonGroup>

      <RibbonSeparator />

      <RibbonGroup title="Calculation">
        <CalculationGroup context={context} />
      </RibbonGroup>
    </div>
  );
}