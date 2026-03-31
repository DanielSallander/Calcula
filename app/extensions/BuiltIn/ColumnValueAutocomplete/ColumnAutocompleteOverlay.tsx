//! FILENAME: app/extensions/BuiltIn/ColumnValueAutocomplete/ColumnAutocompleteOverlay.tsx
// PURPOSE: Overlay component rendering the column value autocomplete dropdown.
// CONTEXT: Registered as an overlay via OverlayExtensions. Reads from the Zustand store.

import React, { useRef, useEffect } from "react";
import type { OverlayProps } from "../../../src/api/uiTypes";
import { useColumnAutocompleteStore } from "./useColumnAutocompleteStore";
import * as S from "./ColumnAutocompleteOverlay.styles";

const DROPDOWN_WIDTH = 220;
const DROPDOWN_MAX_HEIGHT = 180;

/**
 * Overlay component for column value autocomplete.
 * Shows a simple list of matching values from the same column.
 */
export function ColumnAutocompleteOverlay(
  _props: OverlayProps
): React.ReactElement | null {
  const { visible, items, selectedIndex, anchorRect, accept, currentValue } =
    useColumnAutocompleteStore();

  const listRef = useRef<HTMLDivElement>(null);

  // Scroll the selected item into view when selectedIndex changes
  useEffect(() => {
    const container = listRef.current;
    if (!container || !visible) return;
    const selectedEl = container.children[selectedIndex] as
      | HTMLElement
      | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, visible]);

  if (!visible || !anchorRect || items.length === 0) return null;

  // Position: below the anchor cell, clamped to viewport
  const dropdownX = Math.min(
    anchorRect.x,
    window.innerWidth - DROPDOWN_WIDTH - 8
  );
  let dropdownY = anchorRect.y;

  // If dropdown would overflow below, show above the editor cell
  const dropdownOverflows =
    dropdownY + DROPDOWN_MAX_HEIGHT > window.innerHeight - 8;
  const showAbove =
    dropdownOverflows &&
    anchorRect.y - anchorRect.height - DROPDOWN_MAX_HEIGHT > 0;
  if (showAbove) {
    dropdownY = anchorRect.y - anchorRect.height - DROPDOWN_MAX_HEIGHT;
  }

  return (
    <S.DropdownContainer
      ref={listRef}
      style={{
        left: dropdownX,
        top: dropdownY,
        width: DROPDOWN_WIDTH,
        maxHeight: DROPDOWN_MAX_HEIGHT,
      }}
      onMouseDown={preventBlur}
    >
      {items.map((item, idx) => (
        <S.DropdownItem
          key={item}
          $isSelected={idx === selectedIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            accept(idx);
          }}
          onMouseEnter={() =>
            useColumnAutocompleteStore.setState({ selectedIndex: idx })
          }
        >
          <HighlightedValue value={item} typed={currentValue} />
        </S.DropdownItem>
      ))}
    </S.DropdownContainer>
  );
}

/**
 * Renders a value with the typed prefix highlighted (bold).
 */
function HighlightedValue({
  value,
  typed,
}: {
  value: string;
  typed: string;
}): React.ReactElement {
  if (!typed) return <>{value}</>;

  // Case-insensitive prefix match - bold the typed portion
  const matchLen = typed.length;
  if (matchLen >= value.length) return <>{value}</>;

  return (
    <>
      <S.MatchHighlight>{value.substring(0, matchLen)}</S.MatchHighlight>
      {value.substring(matchLen)}
    </>
  );
}

/**
 * Prevent blur on the editor input when clicking autocomplete items.
 */
function preventBlur(e: React.MouseEvent): void {
  e.preventDefault();
}
