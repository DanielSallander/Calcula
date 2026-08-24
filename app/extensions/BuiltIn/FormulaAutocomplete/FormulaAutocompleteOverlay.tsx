//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/FormulaAutocompleteOverlay.tsx
// PURPOSE: Overlay component rendering the autocomplete dropdown and argument hints.
// CONTEXT: Registered as an overlay via OverlayExtensions. Reads from the Zustand store.

import React, { useRef, useEffect, useState, useCallback } from "react";
import type { OverlayProps } from "@api/uiTypes";
import { getCachedLocale } from "@api/locale";
import { useAutocompleteStore } from "./useAutocompleteStore";
import { findArgumentSpans } from "./tokenParser";
import type { ScoredSuggestion } from "../../_shared/lib/functionCatalog";
import type { FunctionInfo } from "@api/types";
import * as S from "./FormulaAutocompleteOverlay.styles";

const DROPDOWN_WIDTH = 340;
const DROPDOWN_MAX_HEIGHT = 220;
const HINT_GAP = 4;
// Approximate height of the argument-hint card (signature + active-param label
// + a short description). Used to keep the hint clear of the dropdown when the
// dropdown is flipped above the editor cell near the viewport bottom.
const ARGUMENT_HINT_HEIGHT = 72;
/** How much of a dragged hint card must stay inside the window. */
const HINT_KEEP_VISIBLE_PX = 48;

/** The hint card sits where it was computed to sit until it is dragged. */
const NO_DRAG_OFFSET = { dx: 0, dy: 0 };

interface HintDrag {
  startX: number;
  startY: number;
  baseDx: number;
  baseDy: number;
}

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
    currentValue,
    currentCursorPosition,
  } = useAutocompleteStore();

  const listRef = useRef<HTMLDivElement>(null);

  /** Where the user has dragged the hint card away from its computed place. */
  const [hintOffset, setHintOffset] = useState(NO_DRAG_OFFSET);
  const [hintDrag, setHintDrag] = useState<HintDrag | null>(null);

  // Scroll the selected item into view when selectedIndex changes
  useEffect(() => {
    const container = listRef.current;
    if (!container || !visible) return;
    const selectedEl = container.children[selectedIndex] as HTMLElement | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, visible]);

  // Follow the pointer for as long as the button is held. The listeners are on
  // the WINDOW because the pointer leaves this small card almost immediately in
  // any real drag; listening on the card itself would drop the drag there.
  useEffect(() => {
    if (!hintDrag) return;
    const onMove = (e: MouseEvent) => {
      setHintOffset({
        dx: hintDrag.baseDx + e.clientX - hintDrag.startX,
        dy: hintDrag.baseDy + e.clientY - hintDrag.startY,
      });
    };
    const onUp = () => setHintDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [hintDrag]);

  // A card was dragged clear of one call's arguments; the next edit gets a
  // fresh one under its own editor rather than wherever the last one ended up.
  useEffect(() => {
    if (argumentHintVisible) return;
    setHintOffset((prev) => (prev.dx === 0 && prev.dy === 0 ? prev : NO_DRAG_OFFSET));
  }, [argumentHintVisible]);

  const beginHintDrag = useCallback(
    (e: React.MouseEvent) => {
      // preventDefault does the job the card's plain preventBlur handler did:
      // the press must not move focus off the editor, because losing focus ends
      // the edit the card is describing.
      e.preventDefault();
      setHintDrag({
        startX: e.clientX,
        startY: e.clientY,
        baseDx: hintOffset.dx,
        baseDy: hintOffset.dy,
      });
    },
    [hintOffset]
  );

  /**
   * Clicking a parameter selects that argument's text in the editor, so it can
   * be typed straight over.
   *
   * The spans come from the same scan the bolded parameter does
   * (`findArgumentSpans`), so what gets selected is always what the card was
   * pointing at. The editor is `document.activeElement` because the press was
   * preventDefault-ed above and focus never left it -- which is also why this
   * one line serves EVERY formula editor that feeds the card (the grid cell,
   * the formula bar, the defined-name and control-property fields) without any
   * of them having to know the card exists.
   */
  const selectArgument = useCallback(
    (index: number) => {
      const span = findArgumentSpans(currentValue, currentCursorPosition)[index];
      // A parameter the signature lists but the user has not typed yet has no
      // text to select.
      if (!span) return;
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
      el.setSelectionRange(span.start, span.end);
    },
    [currentValue, currentCursorPosition]
  );

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
      ? dropdownY - ARGUMENT_HINT_HEIGHT - HINT_GAP
      : dropdownY + estimatedDropdownHeight + HINT_GAP;
  } else {
    hintY = anchorRect.y + HINT_GAP;
  }

  // Where the card actually sits: its computed place plus wherever it has been
  // dragged. The clamp belongs to the DRAG -- it is what stops the card being
  // parked past the edge of the window, from where it could never be dragged
  // back -- so an undragged card keeps exactly the position computed above.
  const hintLeft = hintOffset.dx === 0 ? dropdownX : clampHintPos(dropdownX + hintOffset.dx, window.innerWidth);
  const hintTop = hintOffset.dy === 0 ? hintY : clampHintPos(hintY + hintOffset.dy, window.innerHeight);

  return (
    <>
      {/* Suggestion Dropdown */}
      {visible && items.length > 0 && (
        <S.DropdownContainer
          ref={listRef}
          data-testid="formula-autocomplete"
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
              key={`${item.kind}-${item.name}`}
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
          data-testid="formula-argument-hint"
          style={{ left: hintLeft, top: hintTop }}
          onMouseDown={beginHintDrag}
        >
          <ArgumentHint
            func={argumentHintFunction}
            activeArgIndex={argumentHintIndex}
            onSelectArgument={selectArgument}
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
 * Handles both function and named range suggestions.
 */
function DropdownItem({
  item,
  isSelected,
  onAccept,
  onHover,
}: {
  item: ScoredSuggestion;
  isSelected: boolean;
  onAccept: () => void;
  onHover: () => void;
}): React.ReactElement {
  const categoryTag = item.kind === "function"
    ? (item.info?.category ?? "")
    : "Named Range";
  const description = item.kind === "function"
    ? (item.info?.description ?? "")
    : (item.refersTo ?? "");

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
        <HighlightedName name={item.name} ranges={item.matchRanges} />
      </S.FunctionNameContainer>
      <S.CategoryTag>{categoryTag}</S.CategoryTag>
      <S.Description>{description}</S.Description>
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
 * Renders an intellisense card for the enclosing function: the signature with
 * the active argument shown as a filled chip, a label naming the active
 * parameter (and whether it is optional), and the function description.
 *
 * Every named parameter is a click target that selects the matching argument in
 * the editor (`onSelectArgument`), which is what makes the signature a way to
 * NAVIGATE the call rather than just a legend for it.
 *
 * Parses the syntax string (e.g., "SUM(number1, [number2], ...)").
 */
function ArgumentHint({
  func,
  activeArgIndex,
  onSelectArgument,
}: {
  func: FunctionInfo;
  activeArgIndex: number;
  onSelectArgument: (index: number) => void;
}): React.ReactElement {
  const { syntax, description } = func;

  // Parse: "SUM(number1, [number2], ...)" -> extract args between parens
  const openParen = syntax.indexOf("(");
  const closeParen = syntax.lastIndexOf(")");

  if (openParen === -1 || closeParen === -1 || closeParen <= openParen) {
    // Fallback: no parseable parameter list -- show the raw syntax + description.
    return (
      <>
        <S.SignatureLine>{syntax}</S.SignatureLine>
        {description && <S.HintDescription>{description}</S.HintDescription>}
      </>
    );
  }

  const funcName = syntax.substring(0, openParen);
  const argsStr = syntax.substring(openParen + 1, closeParen);

  // Split on commas (respecting nested brackets/parens)
  const args = splitArguments(argsStr);
  const displaySep = (getCachedLocale()?.listSeparator ?? ",") + " ";

  // Which listed parameter to treat as active. For variadic functions the
  // cursor can move past the last listed parameter -- keep the last repeatable
  // named parameter highlighted rather than highlighting nothing.
  const activeIdx = resolveActiveArgIndex(args, activeArgIndex);
  const activeArgText = activeIdx >= 0 ? args[activeIdx] : "";
  const activeIsOptional = activeArgText.startsWith("[");
  const activeParamName = stripArgDecorations(activeArgText);

  return (
    <>
      <S.SignatureLine>
        <S.FnName>{funcName}</S.FnName>(
        {args.map((arg, i) => {
          // The trailing "..." of a variadic signature stands for arguments
          // rather than naming one -- it strips to nothing -- so there is
          // nothing for a click on it to select.
          const selectable = stripArgDecorations(arg) !== "";
          const onMouseDown = selectable
            ? (e: React.MouseEvent) => {
                // Keep the press off the card's drag handler: a click that
                // means "select this argument" must not also start a drag.
                e.preventDefault();
                e.stopPropagation();
                onSelectArgument(i);
              }
            : undefined;
          return (
            <React.Fragment key={i}>
              {i > 0 && displaySep}
              {i === activeIdx ? (
                <S.ActiveArg $selectable={selectable} onMouseDown={onMouseDown}>
                  {arg}
                </S.ActiveArg>
              ) : (
                <S.InactiveArg $selectable={selectable} onMouseDown={onMouseDown}>
                  {arg}
                </S.InactiveArg>
              )}
            </React.Fragment>
          );
        })}
        )
      </S.SignatureLine>
      {activeParamName && activeParamName !== "..." && (
        <S.ActiveParamLabel>
          <strong>{activeParamName}</strong>
          {activeIsOptional && <S.ParamOptionalNote>optional</S.ParamOptionalNote>}
        </S.ActiveParamLabel>
      )}
      {description && <S.HintDescription>{description}</S.HintDescription>}
    </>
  );
}

/**
 * Pick which listed parameter is "active" for the given argument index,
 * clamping into range and keeping the last repeatable parameter highlighted
 * for variadic functions (whose syntax ends in "...").
 */
function resolveActiveArgIndex(args: string[], activeArgIndex: number): number {
  if (args.length === 0) return -1;
  if (activeArgIndex < 0) return 0;
  if (activeArgIndex < args.length) return activeArgIndex;

  // Past the last listed parameter. If the function is variadic, keep the last
  // NAMED parameter before the trailing "..." highlighted; otherwise clamp.
  const last = args[args.length - 1];
  if (last === "..." || last.endsWith("...")) {
    return Math.max(0, args.length - 2);
  }
  return args.length - 1;
}

/**
 * Strip decorative characters from a parameter token so the active-param label
 * shows a clean name: "[number2]" -> "number2", "value..." -> "value".
 */
function stripArgDecorations(arg: string): string {
  return arg.replace(/^\[|\]$/g, "").replace(/\.\.\.$/, "").trim();
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
 * Keep a dragged hint card's leading edge inside the window, with enough of it
 * showing to grab again.
 */
function clampHintPos(pos: number, extent: number): number {
  return Math.max(0, Math.min(pos, extent - HINT_KEEP_VISIBLE_PX));
}

/**
 * Prevent blur on the editor input when clicking autocomplete items.
 */
function preventBlur(e: React.MouseEvent): void {
  e.preventDefault();
}
