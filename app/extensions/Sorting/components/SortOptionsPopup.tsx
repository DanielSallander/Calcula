//! FILENAME: app/extensions/Sorting/components/SortOptionsPopup.tsx
// PURPOSE: Options popup for advanced sort settings.
// CONTEXT: Provides case sensitivity toggle and sort orientation (rows vs columns).

import React, { useCallback, useRef, useEffect } from "react";
import type { SortOrientation } from "../../../src/api/lib";
import * as S from "./SortDialog.styles";

// ============================================================================
// Props
// ============================================================================

interface SortOptionsPopupProps {
  caseSensitive: boolean;
  orientation: SortOrientation;
  onCaseSensitiveChange: (value: boolean) => void;
  onOrientationChange: (value: SortOrientation) => void;
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function SortOptionsPopup({
  caseSensitive,
  orientation,
  onCaseSensitiveChange,
  onOrientationChange,
  onClose,
}: SortOptionsPopupProps): React.ReactElement {
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <S.OptionsPopupBackdrop onClick={handleBackdropClick}>
      <S.OptionsPopupContainer ref={popupRef}>
        <S.OptionsPopupTitle>Sort Options</S.OptionsPopupTitle>

        {/* Case Sensitivity */}
        <S.OptionsGroup>
          <S.OptionsGroupLabel>Case Sensitivity</S.OptionsGroupLabel>
          <S.Checkbox>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => onCaseSensitiveChange(e.target.checked)}
            />
            Case sensitive
          </S.Checkbox>
        </S.OptionsGroup>

        {/* Orientation */}
        <S.OptionsGroup>
          <S.OptionsGroupLabel>Orientation</S.OptionsGroupLabel>
          <S.RadioLabel>
            <input
              type="radio"
              name="sort-orientation"
              checked={orientation === "rows"}
              onChange={() => onOrientationChange("rows")}
            />
            Sort top to bottom
          </S.RadioLabel>
          <S.RadioLabel>
            <input
              type="radio"
              name="sort-orientation"
              checked={orientation === "columns"}
              onChange={() => onOrientationChange("columns")}
            />
            Sort left to right
          </S.RadioLabel>
        </S.OptionsGroup>

        <S.OptionsPopupFooter>
          <S.Button onClick={onClose}>OK</S.Button>
        </S.OptionsPopupFooter>
      </S.OptionsPopupContainer>
    </S.OptionsPopupBackdrop>
  );
}
