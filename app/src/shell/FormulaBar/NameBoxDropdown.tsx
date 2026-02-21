//! FILENAME: app/src/shell/FormulaBar/NameBoxDropdown.tsx
// PURPOSE: Dropdown list of all defined names shown below the NameBox.
// CONTEXT: Clicking a name navigates to its range. Closed on blur/escape/outside click.

import React, { useEffect, useRef, useCallback } from "react";
import type { NamedRange } from "../../api";
import * as S from "./NameBox.styles";

interface NameBoxDropdownProps {
  names: NamedRange[];
  onSelect: (name: NamedRange) => void;
  onClose: () => void;
}

export function NameBoxDropdown({
  names,
  onSelect,
  onClose,
}: NameBoxDropdownProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown, { capture: true });
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, {
        capture: true,
      });
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const handleItemClick = useCallback(
    (nr: NamedRange) => {
      onSelect(nr);
    },
    [onSelect]
  );

  if (names.length === 0) return null;

  return (
    <S.DropdownContainer ref={containerRef}>
      {names.map((nr) => (
        <S.DropdownItem
          key={nr.name}
          onMouseDown={(e) => {
            e.preventDefault();
            handleItemClick(nr);
          }}
        >
          <S.DropdownItemName>{nr.name}</S.DropdownItemName>
          <S.DropdownItemRef>{nr.refersTo}</S.DropdownItemRef>
        </S.DropdownItem>
      ))}
    </S.DropdownContainer>
  );
}
