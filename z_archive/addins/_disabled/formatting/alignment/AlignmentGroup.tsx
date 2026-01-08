// FILENAME: app/src/components/Ribbon/tabs/HomeTab/AlignmentGroup.tsx
// PURPOSE: Alignment formatting group for the Home tab.
// CONTEXT: Contains text alignment, wrap text, and text rotation controls.

import React, { useState, useCallback, useRef } from "react";
import type { RibbonContext } from "../../../../core/extensions/types";
import { RibbonButton } from "../../../../shell/Ribbon/components";
import { applyFormatting } from "../../../../core/lib/tauri-api";
import { buttonRowStyles } from "../../../../shell/Ribbon/styles/styles";
import { AlignLeftIcon, AlignCenterIcon, AlignRightIcon, WrapTextIcon, RotateUpIcon, RotateDownIcon } from "../shared/icons";

interface AlignmentGroupProps {
  context: RibbonContext;
}

/**
 * Alignment formatting controls.
 */
export function AlignmentGroup({
  context,
}: AlignmentGroupProps): React.ReactElement {
  const { selection, isDisabled, onCellsUpdated } = context;
  const [isApplying, setIsApplying] = useState(false);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const getSelectionRange = useCallback((): { rows: number[]; cols: number[] } => {
    const currentSelection = selectionRef.current;
    if (!currentSelection) {
      return { rows: [], cols: [] };
    }

    const minRow = Math.min(currentSelection.startRow, currentSelection.endRow);
    const maxRow = Math.max(currentSelection.startRow, currentSelection.endRow);
    const minCol = Math.min(currentSelection.startCol, currentSelection.endCol);
    const maxCol = Math.max(currentSelection.startCol, currentSelection.endCol);

    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = minRow; r <= maxRow; r++) rows.push(r);
    for (let c = minCol; c <= maxCol; c++) cols.push(c);

    return { rows, cols };
  }, []);

  const applyFormat = useCallback(
    async (formatting: Record<string, unknown>) => {
      const currentSelection = selectionRef.current;
      if (!currentSelection || isDisabled || isApplying) return;

      const { rows, cols } = getSelectionRange();
      if (rows.length === 0 || cols.length === 0) return;

      setIsApplying(true);
      try {
        await applyFormatting(rows, cols, formatting);
        if (onCellsUpdated) await onCellsUpdated();
      } catch (error) {
        console.error("[AlignmentGroup] Failed to apply formatting:", error);
      } finally {
        setIsApplying(false);
      }
    },
    [isDisabled, isApplying, getSelectionRange, onCellsUpdated]
  );

  const handleAlign = useCallback(
    (align: "left" | "center" | "right") => {
      console.log("[AlignmentGroup] Align:", align);
      applyFormat({ textAlign: align });
    },
    [applyFormat]
  );

  const handleWrapText = useCallback(() => {
    console.log("[AlignmentGroup] Wrap text clicked");
    applyFormat({ wrapText: true });
  }, [applyFormat]);

  const handleRotation = useCallback(
    (rotation: "none" | "rotate90" | "rotate270") => {
      console.log("[AlignmentGroup] Rotation:", rotation);
      applyFormat({ textRotation: rotation });
    },
    [applyFormat]
  );

  const effectiveDisabled = isDisabled || isApplying;

  return (
    <>
      <div style={buttonRowStyles}>
        <RibbonButton
          onClick={() => handleAlign("left")}
          disabled={effectiveDisabled}
          title="Align Left"
        >
          <AlignLeftIcon />
        </RibbonButton>
        <RibbonButton
          onClick={() => handleAlign("center")}
          disabled={effectiveDisabled}
          title="Align Center"
        >
          <AlignCenterIcon />
        </RibbonButton>
        <RibbonButton
          onClick={() => handleAlign("right")}
          disabled={effectiveDisabled}
          title="Align Right"
        >
          <AlignRightIcon />
        </RibbonButton>
      </div>
      <div style={buttonRowStyles}>
        <RibbonButton
          onClick={handleWrapText}
          disabled={effectiveDisabled}
          title="Wrap Text"
        >
          <WrapTextIcon />
        </RibbonButton>
        <RibbonButton
          onClick={() => handleRotation("rotate90")}
          disabled={effectiveDisabled}
          title="Rotate Text Up"
        >
          <RotateUpIcon />
        </RibbonButton>
        <RibbonButton
          onClick={() => handleRotation("rotate270")}
          disabled={effectiveDisabled}
          title="Rotate Text Down"
        >
          <RotateDownIcon />
        </RibbonButton>
      </div>
    </>
  );
}