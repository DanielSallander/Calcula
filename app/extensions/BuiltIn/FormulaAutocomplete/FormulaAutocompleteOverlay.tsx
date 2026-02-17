//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/FormulaAutocompleteOverlay.tsx
// PURPOSE: Overlay component rendering the autocomplete dropdown and argument hints.
// CONTEXT: Registered as an overlay via OverlayExtensions. Reads from the Zustand store.

import React, { useRef, useEffect } from "react";
import type { OverlayProps } from "../../../src/api/uiTypes";
import { useAutocompleteStore } from "./useAutocompleteStore";
import type { ScoredFunction } from "./functionCatalog";
import type { FunctionInfo } from "../../../src/api/types";
import * as S from "./FormulaAutocompleteOverlay.styles";

const DROPDOWN_WIDTH = 340;
const DROPDOWN_MAX_HEIGHT = 220;
const HINT_GAP = 4;

/**
 * Main overlay component for formula autocomplete.
 * Contains: function dropdown list + argument hint tooltip.
 */
export function FormulaAutocompleteOverlay(_props: OverlayProps): React.ReactElement | null {
  const {
    visible,
    items,
    selectedIndex,
    anchorRect,
    accept,
    argumentHintVisible,
    argumentHintFunction,
    argumentHintIndex,
  } = useAutocompleteStore();

  const listRef = useRef<HTMLDivElement>(null);

  // Scroll the selected item into view when selectedIndex changes
  useEffect(() => {
    const container = listRef.current;
    if (!container || !visible) return;
    const selectedEl = container.children[selectedIndex] as HTMLElement | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, visible]);

  // Nothing to render
  if (!anchorRect) return null;
  if (!visible && !argumentHintVisible) return null;

  // Calculate dropdown position: below the anchor, clamped to viewport
  const dropdownX = Math.min(anchorRect.x, window.innerWidth - DROPDOWN_WIDTH - 8);
  let dropdownY = anchorRect.y;

  // If dropdown would overflow below the viewport, show above the editor cell
  const dropdownOverflows = dropdownY + DROPDOWN_MAX_HEIGHT > window.innerHeight - 8;
  const showAbove = dropdownOverflows && anchorRect.y - anchorRect.height - DROPDOWN_MAX_HEIGHT > 0;
  if (showAbove) {
    dropdownY = anchorRect.y - anchorRect.height - DROPDOWN_MAX_HEIGHT;
  }

  // Compute the actual dropdown height for argument hint positioning
  const estimatedDropdownHeight = visible ? Math.min(items.length * 38, DROPDOWN_MAX_HEIGHT) : 0;

  // Argument hint position: below the dropdown (or directly below anchor if dropdown hidden)
  let hintY: number;
  if (visible) {
    hintY = showAbove
      ? dropdownY - 24 - HINT_GAP
      : dropdownY + estimatedDropdownHeight + HINT_GAP;
  } else {
    hintY = anchorRect.y + HINT_GAP;
  }

  return (
    <>
      {/* Function Dropdown */}
      {visible && items.length > 0 && (
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
            <DropdownItem
              key={item.info.name}
              item={item}
              isSelected={idx === selectedIndex}
              onAccept={() => accept(idx)}
              onHover={() => useAutocompleteStore.setState({ selectedIndex: idx })}
            />
          ))}
        </S.DropdownContainer>
      )}

      {/* Argument Hint Tooltip */}
      {argumentHintVisible && argumentHintFunction && (
        <S.ArgumentHintContainer
          style={{ left: dropdownX, top: hintY }}
          onMouseDown={preventBlur}
        >
          <ArgumentHint
            func={argumentHintFunction}
            activeArgIndex={argumentHintIndex}
          />
        </S.ArgumentHintContainer>
      )}
    </>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * A single item in the dropdown list.
 */
function DropdownItem({
  item,
  isSelected,
  onAccept,
  onHover,
}: {
  item: ScoredFunction;
  isSelected: boolean;
  onAccept: () => void;
  onHover: () => void;
}): React.ReactElement {
  return (
    <S.DropdownItem
      $isSelected={isSelected}
      onMouseDown={(e) => {
        e.preventDefault();
        onAccept();
      }}
      onMouseEnter={onHover}
    >
      <S.FunctionNameContainer>
        <HighlightedName name={item.info.name} ranges={item.matchRanges} />
      </S.FunctionNameContainer>
      <S.CategoryTag>{item.info.category}</S.CategoryTag>
      <S.Description>{item.info.description}</S.Description>
    </S.DropdownItem>
  );
}

/**
 * Renders a function name with matched characters highlighted.
 */
function HighlightedName({
  name,
  ranges,
}: {
  name: string;
  ranges: Array<[number, number]>;
}): React.ReactElement {
  if (ranges.length === 0) return <>{name}</>;

  const parts: React.ReactNode[] = [];
  let lastEnd = 0;

  for (const [start, end] of ranges) {
    if (start > lastEnd) {
      parts.push(
        <span key={`pre-${start}`}>{name.substring(lastEnd, start)}</span>
      );
    }
    parts.push(
      <S.MatchHighlight key={`match-${start}`}>
        {name.substring(start, end)}
      </S.MatchHighlight>
    );
    lastEnd = end;
  }

  if (lastEnd < name.length) {
    parts.push(<span key="rest">{name.substring(lastEnd)}</span>);
  }

  return <>{parts}</>;
}

/**
 * Renders the function syntax with the active argument highlighted.
 * Parses the syntax string (e.g., "SUM(number1, [number2], ...)") and
 * bolds the argument at `activeArgIndex`.
 */
function ArgumentHint({
  func,
  activeArgIndex,
}: {
  func: FunctionInfo;
  activeArgIndex: number;
}): React.ReactElement {
  const { syntax } = func;

  // Parse: "SUM(number1, [number2], ...)" -> extract args between parens
  const openParen = syntax.indexOf("(");
  const closeParen = syntax.lastIndexOf(")");

  if (openParen === -1 || closeParen === -1 || closeParen <= openParen) {
    // Fallback: just show the full syntax
    return <span>{syntax}</span>;
  }

  const funcName = syntax.substring(0, openParen);
  const argsStr = syntax.substring(openParen + 1, closeParen);

  // Split on commas (respecting nested brackets/parens)
  const args = splitArguments(argsStr);

  return (
    <span>
      <S.FnName>{funcName}</S.FnName>(
      {args.map((arg, i) => (
        <React.Fragment key={i}>
          {i > 0 && ", "}
          {i === activeArgIndex ? (
            <S.ActiveArg>{arg}</S.ActiveArg>
          ) : (
            <span>{arg}</span>
          )}
        </React.Fragment>
      ))}
      )
    </span>
  );
}

/**
 * Split a comma-separated argument string, respecting nested brackets.
 * E.g., "number1, [number2], ..." -> ["number1", "[number2]", "..."]
 */
function splitArguments(argsStr: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;

  for (const ch of argsStr) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

/**
 * Prevent blur on the editor input when clicking autocomplete items.
 */
function preventBlur(e: React.MouseEvent): void {
  e.preventDefault();
}
