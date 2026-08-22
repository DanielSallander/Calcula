//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.tsx
// PURPOSE: Inline cell editor component that renders directly over the cell being edited.
// CONTEXT: Refactored to separate styles into .styles.ts file using styled-components.

import React, { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from "react";
import type { GridConfig, Viewport, EditingCell, DimensionOverrides } from "../../types";
import { isFormulaExpectingReference, createEmptyDimensionOverrides } from "../../types";
import { useGridContext } from "../../state/GridContext";
import {
  editorChromePx,
  computeExpandedEditorWidth,
  computeExpandedEditorHeight,
  heightForMeasuredContent,
  countEditorLines,
  editorLineHeight,
  measureEditorTextWidth,
} from "./expansion";
import * as S from "./InlineEditor.styles";
import { toggleReferenceAtCursor } from "../../lib/formulaRefToggle";
import { getGlobalEditingValue, getArrowRefCursor, isHoveringOverReferenceBorder, isGlobalFormulaMode, setGlobalCursorPosition, getGlobalCursorPosition } from "../../hooks/useEditing";
import { isFormulaAutocompleteVisible, AutocompleteEvents } from "../../../api/formulaAutocomplete";
import { isColumnAutocompleteVisible, ColumnAutocompleteEvents } from "../../../api/columnAutocomplete";
import { rowHeaderGutter, colHeaderGutter } from "../../lib/gridRenderer/layout/headerVisibility";
import { endEditorOpen, type OpenTerminalKey, type PendingTerminal } from "../../lib/editOpenBuffer";

/**
 * Global flag to prevent blur from committing during sheet tab navigation.
 * Other layers signal this via the "editor:preventBlurCommit" AppEvent.
 * Using a global because the blur event fires between mousedown and click,
 * and we need to coordinate across components.
 */
let preventBlurCommit = false;

// Listen for prevent-blur-commit events from other layers (e.g., SheetTabs via API events)
window.addEventListener("editor:preventBlurCommit", (e: Event) => {
  preventBlurCommit = (e as CustomEvent<boolean>).detail;
});

export interface InlineEditorProps {
  /** Current editing state */
  editing: EditingCell;
  /** Grid configuration for cell dimensions */
  config: GridConfig;
  /** Current viewport for scroll position */
  viewport: Viewport;
  /** Custom dimension overrides for columns/rows */
  dimensions?: DimensionOverrides;
  /** Callback to update the editing value */
  onValueChange: (value: string) => void;
  /** Callback to commit the edit */
  onCommit: () => Promise<boolean>;
  /** Callback to cancel the edit */
  onCancel: () => void;
  /** Callback when Tab is pressed (to move to next cell) */
  onTab?: (shiftKey: boolean) => void;
  /** Callback when Enter is pressed (to move down after commit) */
  onEnter?: (shiftKey: boolean) => void;
  /** Callback to restore focus to the grid container after commit */
  onRestoreFocus?: () => void;
  /** Whether the editor is disabled (e.g., during save) */
  disabled?: boolean;
  /** Callback when arrow key is pressed in formula mode to navigate cell references */
  onArrowKeyReference?: (direction: "up" | "down" | "left" | "right", extend?: boolean) => void;
  /** Callback when Ctrl+Enter is pressed (to fill selected range with current entry) */
  onCtrlEnter?: () => Promise<void>;
  /** Zoom factor (1.0 = 100%) */
  zoom?: number;
}

/**
 * Get the width of a specific column, using custom width if set.
 */
function getColumnWidth(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  const customWidth = dimensions.columnWidths.get(col);
  if (customWidth !== undefined && customWidth > 0) {
    return customWidth;
  }
  return config.defaultCellWidth || 100;
}

/**
 * Get the height of a specific row, using custom height if set.
 */
function getRowHeight(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  const customHeight = dimensions.rowHeights.get(row);
  if (customHeight !== undefined && customHeight > 0) {
    return customHeight;
  }
  return config.defaultCellHeight || 20;
}

/**
 * Calculate the X position of a column (left edge) accounting for variable widths.
 */
function calculateColumnX(
  col: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  scrollX: number
): number {
  const rowHeaderWidth = rowHeaderGutter(config);
  let x = rowHeaderWidth;
  for (let c = 0; c < col; c++) {
    x += getColumnWidth(c, config, dimensions);
  }
  return x - scrollX;
}

/**
 * Calculate the Y position of a row (top edge) accounting for variable heights.
 */
function calculateRowY(
  row: number,
  config: GridConfig,
  dimensions: DimensionOverrides,
  scrollY: number
): number {
  const colHeaderHeight = colHeaderGutter(config);
  let y = colHeaderHeight;
  for (let r = 0; r < row; r++) {
    y += getRowHeight(r, config, dimensions);
  }
  return y - scrollY;
}

/**
 * Calculate the total width for a cell spanning multiple columns.
 */
function getMergedWidth(
  startCol: number,
  colSpan: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  let totalWidth = 0;
  for (let c = startCol; c < startCol + colSpan; c++) {
    totalWidth += getColumnWidth(c, config, dimensions);
  }
  return totalWidth;
}

/**
 * Calculate the total height for a cell spanning multiple rows.
 */
function getMergedHeight(
  startRow: number,
  rowSpan: number,
  config: GridConfig,
  dimensions: DimensionOverrides
): number {
  let totalHeight = 0;
  for (let r = startRow; r < startRow + rowSpan; r++) {
    totalHeight += getRowHeight(r, config, dimensions);
  }
  return totalHeight;
}

/** Cell font when the live computed style cannot be read (tests, early mount).
 *  Excel's Calibri 11pt = 11 * 96/72 px. LOGICAL px: scaled by zoom at use. */
const FALLBACK_FONT_PX = 11 * (96 / 72);
const FALLBACK_FONT_FAMILY = "Calibri, sans-serif";
/** Character-width estimate used where no canvas exists to measure with. */
const FALLBACK_CHAR_RATIO = 0.6;

/**
 * Calculate the position and visibility of the inline editor.
 */
function calculateEditorPosition(
  editing: EditingCell,
  config: GridConfig,
  viewport: Viewport,
  dimensions: DimensionOverrides
): {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
} {
  const { row, col, rowSpan = 1, colSpan = 1 } = editing;
  const { rowHeaderWidth, colHeaderHeight } = config;

  // Calculate cell position using proper dimension-aware functions
  const cellX = calculateColumnX(col, config, dimensions, viewport.scrollX);
  const cellY = calculateRowY(row, config, dimensions, viewport.scrollY);
   
  // FIX: Calculate dimensions accounting for merged cell spans
  const cellWidth = colSpan > 1 
    ? getMergedWidth(col, colSpan, config, dimensions)
    : getColumnWidth(col, config, dimensions);
  const cellHeight = rowSpan > 1
    ? getMergedHeight(row, rowSpan, config, dimensions)
    : getRowHeight(row, config, dimensions);

  // Check if cell is visible (not scrolled out of view)
  const visible =
    cellX + cellWidth > rowHeaderWidth &&
    cellY + cellHeight > colHeaderHeight &&
    cellX < window.innerWidth &&
    cellY < window.innerHeight;

  // Clamp position to ensure editor doesn't overlap headers
  const x = Math.max(cellX, rowHeaderWidth);
  const y = Math.max(cellY, colHeaderHeight);

  // Adjust width/height if partially clipped by headers
  const clipLeft = Math.max(0, rowHeaderWidth - cellX);
  const clipTop = Math.max(0, colHeaderHeight - cellY);
  const width = cellWidth - clipLeft;
  const height = cellHeight - clipTop;

  return { x, y, width, height, visible };
}

/**
 * InlineEditor component - renders a text input directly over the cell being edited.
 */
export function InlineEditor(props: InlineEditorProps): React.ReactElement | null {
  const {
    editing,
    config,
    viewport,
    dimensions,
    onValueChange,
    onCommit,
    onCancel,
    onTab,
    onEnter,
    onRestoreFocus,
    disabled = false,
    onArrowKeyReference,
    onCtrlEnter,
    zoom = 1,
  } = props;

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isCommittingRef = useRef(false);
  // FIX: Track when ESC is pressed to prevent blur from committing
  const isCancelingRef = useRef(false);
   
  // Get current sheet context to determine if we should render
  const { state: gridState } = useGridContext();
  const currentSheetIndex = gridState.sheetContext.activeSheetIndex;
  // Counter to force refocus after sheet switches or formula reference insertions
  const [refocusTrigger, setRefocusTrigger] = useState(0);

  // Ensure we have valid dimensions
  const dims = dimensions || createEmptyDimensionOverrides();

  // Calculate position in logical coords then scale by zoom for CSS positioning
  const logicalPos = calculateEditorPosition(editing, config, viewport, dims);

  // ==========================================================================
  // Excel-parity geometry: the box is an OVERLAY
  // ==========================================================================
  //
  // It grows right over whatever is beside it and down over whatever is beneath
  // it, covers both regardless of content, and everything it covered repaints
  // untouched when the edit ends. Nothing under it is read — which is why there
  // is no backend lookup here at all any more, and no IPC round trip in the
  // path between pressing a key and seeing it. See expansion.ts for the rules.
  //
  // From here down the arithmetic is in DEVICE px. The box's chrome is what
  // makes it exact and the chrome does not scale uniformly (flat 2px border,
  // scaled padding), so logical grid coordinates are converted once, here, and
  // the two units are never mixed again.
  const z = zoom || 1;
  const boxX = logicalPos.x * z;
  const boxY = logicalPos.y * z;
  const baseWidth = logicalPos.width * z;
  const baseHeight = logicalPos.height * z;

  /**
   * Live layout, read in one pass by the effect below:
   *   - the grid layer's inner size, which is the edge the box may not cross;
   *   - the height the browser says this entry needs once wrapped.
   *
   * `null` until the first measurement lands, and in any environment with no
   * layout engine (jsdom under vitest), where both fall back to a count-based
   * estimate that agrees with the measurement whenever nothing soft-wraps.
   */
  const [measured, setMeasured] = useState<{
    layerWidth: number;
    layerHeight: number;
    contentHeight: number;
  } | null>(null);

  // The bound is the GRID's edge, not the window's. They are not the same
  // number: the canvas layer is inset by the scrollbar gutters and sits to the
  // right of the sidebar, so measuring the window put the box under the
  // scrollbar — where the layer's own `overflow: hidden` silently clipped it.
  const maxRight = measured
    ? measured.layerWidth
    : typeof window !== "undefined"
      ? window.innerWidth
      : 0;
  const maxBottom = measured
    ? measured.layerHeight
    : typeof window !== "undefined"
      ? window.innerHeight
      : 0;

  const expandedWidth = useMemo(() => {
    // A merged cell already spans its columns; growing past a merge is not a
    // thing Excel does.
    if ((editing.colSpan ?? 1) > 1) return baseWidth;

    const el = inputRef.current;
    let font = "";
    let fontPx = FALLBACK_FONT_PX * z;
    if (el && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const cs = window.getComputedStyle(el);
      const parsed = parseFloat(cs.fontSize);
      // Already device px: the rule is `calc(var(--font-size-cell) * zoom)`.
      if (Number.isFinite(parsed) && parsed > 0) fontPx = parsed;
      if (cs.font) font = cs.font;
    }
    if (!font) font = `${fontPx}px ${FALLBACK_FONT_FAMILY}`;

    const textWidth = measureEditorTextWidth(
      editing.value,
      font,
      fontPx * FALLBACK_CHAR_RATIO
    );

    return computeExpandedEditorWidth({
      x: boxX,
      baseWidth,
      desiredWidth: textWidth + editorChromePx(z),
      maxRight,
    });
  }, [editing.value, editing.colSpan, boxX, baseWidth, maxRight, z]);

  // Height follows the width: once the box is as wide as it may get, whatever
  // still does not fit wraps, and the wrapped height is MEASURED rather than
  // predicted — a JavaScript imitation of Chromium's line breaking would
  // disagree by a line eventually, and a line is the whole error budget.
  const expandedHeight = measured
    ? heightForMeasuredContent({
        y: boxY,
        baseHeight,
        contentHeight: measured.contentHeight,
        maxBottom,
      })
    : computeExpandedEditorHeight({
        y: boxY,
        baseHeight,
        lineCount: countEditorLines(editing.value),
        maxBottom,
      });

  /**
   * Measure the wrapped entry and the grid layer, before the browser paints.
   *
   * `height: auto` FIRST, and this is the subtle part: `scrollHeight` never
   * reports less than the element's own client height, so measuring at the
   * height the box currently has would latch it at its high-water mark — the
   * box would grow as the entry grew and then never shrink back when the user
   * deleted the text again. Both writes happen inside one layout pass, so
   * nothing paints in between and there is no flicker.
   *
   * Deliberately no dependency array. The layer's size can change without any
   * prop of this component changing (a task pane opening, a window resize), and
   * the state update below is a no-op when nothing moved, so re-running per
   * render costs one layout read and converges immediately.
   */
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    const previousHeight = el.style.height;
    el.style.height = "auto";
    const contentHeight = el.scrollHeight;
    el.style.height = previousHeight;

    // No layout engine (jsdom): leave the count-based estimate in charge rather
    // than collapsing the box to its chrome.
    if (!(contentHeight > 0)) return;

    const layer = el.offsetParent as HTMLElement | null;
    const layerWidth = layer?.clientWidth ?? 0;
    const layerHeight = layer?.clientHeight ?? 0;
    if (!(layerWidth > 0) || !(layerHeight > 0)) return;

    setMeasured((prev) =>
      prev &&
      prev.contentHeight === contentHeight &&
      prev.layerWidth === layerWidth &&
      prev.layerHeight === layerHeight
        ? prev
        : { layerWidth, layerHeight, contentHeight }
    );
  });

  const position = {
    x: boxX,
    y: boxY,
    width: expandedWidth,
    height: expandedHeight,
    visible: logicalPos.visible,
  };

  /**
   * Handle input value changes.
   */
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (!disabled) {
        onValueChange(event.target.value);

        // FIX: Track cursor position globally for cursor-aware formula mode detection
        const inputEl = inputRef.current;
        const cursorPos = inputEl?.selectionStart ?? event.target.value.length;
        setGlobalCursorPosition(cursorPos);

        // Emit autocomplete input event with cursor position and anchor rect.
        // Use getBoundingClientRect() for accurate viewport-relative positioning,
        // matching what FormulaBar and other emitters do.
        console.log("[InlineEditor] handleChange, dispatching autocomplete:input for:", event.target.value);
        if (inputEl) {
          const rect = inputEl.getBoundingClientRect();
          window.dispatchEvent(
            new CustomEvent(AutocompleteEvents.INPUT, {
              detail: {
                value: event.target.value,
                cursorPosition: cursorPos,
                anchorRect: {
                  x: rect.left,
                  y: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                },
                source: "inline",
                row: editing.row,
                col: editing.col,
              },
            })
          );
        }
      }
    },
    [onValueChange, disabled, editing.row, editing.col]
  );

  /**
   * FIX: Track cursor position changes from arrow keys, mouse clicks within input, etc.
   * This ensures globalCursorPosition stays accurate even when the value doesn't change.
   */
  const handleSelect = useCallback(() => {
    if (inputRef.current) {
      setGlobalCursorPosition(inputRef.current.selectionStart ?? inputRef.current.value.length);
    }
  }, []);

  /**
   * Carry out an edit-ending key: Enter commits and moves, Tab commits and
   * moves sideways, Escape cancels.
   *
   * Shared deliberately. It runs both for a key pressed on the live editor and
   * for one REPLAYED from the editor-open window (a key the user pressed
   * before this editor existed), so "type a value and hit Enter immediately"
   * cannot end up meaning something subtly different from pressing Enter a
   * moment later.
   */
  const runTerminalKey = useCallback(
    async (key: OpenTerminalKey, shiftKey: boolean): Promise<void> => {
      if (key === "Escape") {
        // FIX: Set canceling flag BEFORE calling onCancel to prevent blur from committing
        isCancelingRef.current = true;
        onCancel();
        // Restore focus to grid container so keyboard navigation works
        onRestoreFocus?.();
        return;
      }

      isCommittingRef.current = true;
      try {
        const success = await onCommit();
        if (success) {
          if (key === "Enter") onEnter?.(shiftKey);
          else onTab?.(shiftKey);
        }
        // Restore focus to grid container so keyboard navigation works
        onRestoreFocus?.();
      } finally {
        isCommittingRef.current = false;
      }
    },
    [onCommit, onCancel, onEnter, onTab, onRestoreFocus]
  );

  /**
   * An edit-ending key that arrived before this editor was ready, waiting to be
   * replayed. Held in state rather than run straight from the focus effect so
   * that it runs from a render that already sees the final entry value and the
   * matching `onCommit` -- replaying it inline would commit the value as it was
   * one render ago.
   */
  const [pendingTerminal, setPendingTerminal] = useState<PendingTerminal | null>(null);

  useEffect(() => {
    if (!pendingTerminal || disabled) return;
    // Cleared first, so the re-render this causes re-enters the effect as a
    // no-op instead of replaying the key twice.
    setPendingTerminal(null);
    void runTerminalKey(pendingTerminal.key, pendingTerminal.shiftKey);
  }, [pendingTerminal, disabled, runTerminalKey]);

  /**
   * Handle keyboard events.
   * FIX: Added F4 handler to toggle absolute/relative cell reference modes.
   */
  const handleKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (disabled || isCommittingRef.current) {
        // In a <textarea> both of these keys have a DEFAULT text-mutating
        // action. The old <input> made that harmless (it inserted nothing and
        // sanitized newlines away); here an Enter arriving while a commit is
        // in flight would append a line break to an entry that is already on
        // its way to the backend, and a Tab would put a literal tab in it.
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
        }
        return;
      }

      // Intercept keys for formula autocomplete when the dropdown is visible
      if (isFormulaAutocompleteVisible()) {
        const autocompleteKeys = ["ArrowUp", "ArrowDown", "Tab", "Escape", "Enter"];
        if (autocompleteKeys.includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(AutocompleteEvents.KEY, {
              detail: { key: event.key },
            })
          );
          return;
        }
      }

      // Intercept keys for column value autocomplete when its dropdown is visible
      if (isColumnAutocompleteVisible()) {
        const columnAutoKeys = ["ArrowUp", "ArrowDown", "Tab", "Escape", "Enter"];
        if (columnAutoKeys.includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(ColumnAutocompleteEvents.KEY, {
              detail: { key: event.key },
            })
          );
          return;
        }
      }

      switch (event.key) {
        case "Enter":
          // Alt+Enter - insert newline in cell
          if (event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            const inputEl = inputRef.current;
            if (inputEl) {
              const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
              const currentValue = inputEl.value;
              const newValue = currentValue.slice(0, cursorPos) + "\n" + currentValue.slice(cursorPos);
              onValueChange(newValue);
              // Restore cursor position after the inserted newline
              requestAnimationFrame(() => {
                if (inputRef.current) {
                  inputRef.current.setSelectionRange(cursorPos + 1, cursorPos + 1);
                }
              });
            }
            break;
          }
          // Ctrl+Enter - fill selected range with current entry
          if ((event.ctrlKey || event.metaKey) && onCtrlEnter) {
            event.preventDefault();
            event.stopPropagation();
            console.log("[InlineEditor] Ctrl+Enter pressed, filling selection");
            isCommittingRef.current = true;
            try {
              await onCtrlEnter();
              onRestoreFocus?.();
            } finally {
              isCommittingRef.current = false;
            }
            break;
          }
          // Normal Enter - commit and move down/up
          event.preventDefault();
          event.stopPropagation();
          console.log("[InlineEditor] Enter pressed, starting commit");
          await runTerminalKey("Enter", event.shiftKey);
          break;

        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          await runTerminalKey("Escape", event.shiftKey);
          break;

        case "Tab":
          event.preventDefault();
          event.stopPropagation();
          await runTerminalKey("Tab", event.shiftKey);
          break;

        case "F4": {
          // FIX: Toggle absolute/relative reference mode on the cell reference
          // at the current cursor position. Only active when editing a formula.
          //
          // IMPORTANT: Use getGlobalEditingValue() instead of reading from the DOM
          // or React state. This is because:
          // 1. The input is a controlled React component (value comes from props)
          // 2. React state updates are asynchronous
          // 3. When F4 is pressed rapidly, React may not have re-rendered yet
          // 4. getGlobalEditingValue() is updated synchronously in updateValue()
          const inputEl = inputRef.current;
          if (!inputEl) break;

          // Use global value (updated synchronously) with fallback to DOM
          const currentValue = getGlobalEditingValue() || inputEl.value;
          if (currentValue.startsWith("=")) {
            event.preventDefault();
            event.stopPropagation();
            const cursorPos = inputEl.selectionStart ?? 0;
            const result = toggleReferenceAtCursor(currentValue, cursorPos);
            if (result.formula !== currentValue) {
              onValueChange(result.formula);
              // Restore cursor position after React re-renders the input value
              requestAnimationFrame(() => {
                inputEl.setSelectionRange(result.cursorPos, result.cursorPos);
              });
            }
          }
          break;
        }

        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          // Handle arrow keys for cell reference navigation in formula mode
          // When in formula mode (expecting a reference) OR when we're already navigating
          // a reference with arrow keys, arrow keys insert/navigate cell references
          // instead of moving the cursor within the text
          const currentVal = getGlobalEditingValue() || editing.value;
          const isInArrowNavMode = getArrowRefCursor() !== null;
          // FIX: Use cursor-aware check for formula mode detection
          const isExpectingRef = isFormulaExpectingReference(currentVal, getGlobalCursorPosition());

          // Continue arrow navigation if:
          // 1. Formula is expecting a reference (e.g., "=" or "=A1+")
          // 2. OR we're already in arrow navigation mode (e.g., just pressed arrow to get "=B1")
          if (onArrowKeyReference && (isExpectingRef || isInArrowNavMode)) {
            event.preventDefault();
            event.stopPropagation();

            const directionMap: Record<string, "up" | "down" | "left" | "right"> = {
              "ArrowUp": "up",
              "ArrowDown": "down",
              "ArrowLeft": "left",
              "ArrowRight": "right",
            };

            onArrowKeyReference(directionMap[event.key], event.shiftKey);
          }
          // If not in formula mode and not in arrow nav mode, let arrow keys work normally
          break;
        }

        default:
          // Let other keys propagate normally for text input
          break;
      }
    },
    [runTerminalKey, onCtrlEnter, onRestoreFocus, disabled, onValueChange, onArrowKeyReference, editing.value]
  );

  /**
   * Handle blur - commit edit when focus leaves the editor.
   * Uses the actual input value at blur time to avoid stale closure issues.
   * Also checks the global preventBlurCommit flag set by SheetTabs.
   * FIX: Also checks isCancelingRef to prevent commit after ESC.
   */
  const handleBlur = useCallback(
    async (event: React.FocusEvent<HTMLTextAreaElement>) => {
      // Don't commit if already committing (e.g., from Enter key)
      if (isCommittingRef.current || disabled) {
        return;
      }

      // FIX: Don't commit if we're canceling (ESC was pressed)
      if (isCancelingRef.current) {
        console.log("[InlineEditor] Blur prevented - cancel in progress");
        return;
      }

      // Check the global flag set by SheetTabs during formula mode navigation
      if (preventBlurCommit) {
        console.log("[InlineEditor] Blur prevented by global flag");
        return;
      }

      // Don't commit if an autocomplete dropdown is visible (user may be clicking an item)
      if (isFormulaAutocompleteVisible()) {
        console.log("[InlineEditor] Blur prevented - formula autocomplete visible");
        return;
      }
      if (isColumnAutocompleteVisible()) {
        console.log("[InlineEditor] Blur prevented - column autocomplete visible");
        return;
      }

      // FIX: Check if cursor is hovering over a reference border (about to start a drag)
      // The blur fires BEFORE the mousedown handler can set preventBlurCommit, so we
      // check the hover state to know if the click was on a reference border.
      if (isHoveringOverReferenceBorder()) {
        console.log("[InlineEditor] Blur prevented - hovering over reference border");
        return;
      }

      // FIX: Don't commit if we're in arrow reference navigation mode.
      // When navigating cell references with arrow keys, dispatchReferenceInsertedEvent()
      // causes the container to grab focus (for cross-sheet support), which blurs the
      // InlineEditor. On the second arrow press, the DOM value no longer ends with an
      // operator (e.g., "=VLOOKUP(B2"), so isFormulaExpectingReference returns false.
      // But arrowRefCursor being non-null means we're actively navigating references.
      if (getArrowRefCursor() !== null) {
        console.log("[InlineEditor] Blur prevented - arrow reference navigation active");
        return;
      }

      // FIX: Check BOTH the DOM input value AND the synchronous global state.
      // The DOM value may be stale if React hasn't re-rendered this controlled input yet
      // (e.g., user typed a comma in the formula bar but InlineEditor hasn't re-rendered).
      // isGlobalFormulaMode() checks the module-level globalEditingValue which is updated
      // synchronously when the user types.
      const currentValue = event.target.value;
      const isCurrentlyInFormulaMode = isFormulaExpectingReference(currentValue) || isGlobalFormulaMode();

      if (isCurrentlyInFormulaMode) {
        console.log("[InlineEditor] Blur prevented - formula mode active, value:", currentValue);
        return;
      }

      // Check if focus is moving to the formula bar input
      // FIX: Ensure data-formula-bar attribute is checked
      const relatedTarget = event.relatedTarget as HTMLElement | null;
      if (relatedTarget?.getAttribute("data-formula-bar") === "true") {
        return;
      }

      // Focus moving elsewhere - commit
      console.log("[InlineEditor] Blur committing, value:", currentValue);
      isCommittingRef.current = true;
      try {
        // Restore focus to grid container so keyboard navigation works
        onRestoreFocus?.();
        await onCommit();
      } finally {
        isCommittingRef.current = false;
      }
    },
    [onCommit, disabled, onRestoreFocus]
  );

  /**
   * Listen for sheet switch events during formula mode.
   * When the user switches sheets while editing a formula, we need to refocus
   * the input so they can continue editing and selecting cells.
   */
  useEffect(() => {
    const handleFormulaModeSheetSwitch = () => {
      console.log("[InlineEditor] Received sheet switch event, will refocus");
      // NOTE: Don't clear preventBlurCommit here - let the auto-focus useEffect do it
      // after the focus is actually restored. This prevents race conditions where
      // a blur event fires before the setTimeout focus completes.
      // Trigger a refocus by updating the trigger counter
      setRefocusTrigger(prev => prev + 1);
    };

    window.addEventListener("sheet:formulaModeSwitch", handleFormulaModeSheetSwitch);
    
    return () => {
      window.removeEventListener("sheet:formulaModeSwitch", handleFormulaModeSheetSwitch);
    };
  }, []);

  /**
   * FIX: Listen for formula reference insertion events.
   * When the user clicks a cell to add a reference during formula editing,
   * we need to refocus the input so they can continue typing.
   */
  useEffect(() => {
    const handleReferenceInserted = () => {
      console.log("[InlineEditor] Reference inserted, will refocus");
      // NOTE: Don't clear preventBlurCommit here - let the auto-focus useEffect do it
      // after the focus is actually restored. This prevents race conditions where
      // a blur event fires before the setTimeout focus completes.
      // Trigger a refocus by updating the trigger counter
      setRefocusTrigger(prev => prev + 1);
    };

    window.addEventListener("formula:referenceInserted", handleReferenceInserted);
    
    return () => {
      window.removeEventListener("formula:referenceInserted", handleReferenceInserted);
    };
  }, []);

  /**
   * Listen for autocomplete accepted events.
   * When the user selects a function from the autocomplete dropdown,
   * update the input value and restore the cursor position.
   */
  useEffect(() => {
    const handleAccepted = (e: Event) => {
      const { newValue, newCursorPosition } = (e as CustomEvent).detail;
      onValueChange(newValue);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        }
      });
    };

    window.addEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
    return () => window.removeEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
  }, [onValueChange]);

  /**
   * Listen for column autocomplete accepted events.
   * When the user selects a value from the column autocomplete dropdown,
   * update the input value and place cursor at the end.
   */
  useEffect(() => {
    const handleColumnAccepted = (e: Event) => {
      const { newValue } = (e as CustomEvent).detail;
      onValueChange(newValue);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const len = newValue.length;
          inputRef.current.setSelectionRange(len, len);
        }
      });
    };

    window.addEventListener(ColumnAutocompleteEvents.ACCEPTED, handleColumnAccepted);
    return () => window.removeEventListener(ColumnAutocompleteEvents.ACCEPTED, handleColumnAccepted);
  }, [onValueChange]);

  /**
   * Auto-focus the input when editing starts or when triggered by sheet switch.
   * Also clears the preventBlurCommit flag AFTER focus is restored to prevent
   * race conditions where blur fires before focus is set.
   */
  useEffect(() => {
    if (!position.visible || disabled || !inputRef.current) {
      // This editor is not going to take focus on this pass, so the grid
      // container will keep receiving keystrokes. Release the open window all
      // the same -- leaving it latched would buffer the user's typing into an
      // entry that nothing is going to show. Anything already buffered is
      // still in the entry; only a key that ends the edit needs replaying.
      const stranded = endEditorOpen();
      if (stranded) setPendingTerminal(stranded);
      return;
    }

    // Use setTimeout to ensure focus happens after any pending DOM updates
    // This is especially important after sheet switches
    const timeoutId = setTimeout(() => {
        if (inputRef.current) {
          // The editor is ready: keystrokes now land on it directly, so the
          // open window closes here. Whatever ended the entry while it was
          // still opening (Enter/Tab/Escape typed faster than the editor could
          // mount) is replayed through this editor's own handlers.
          const replay = endEditorOpen();
          if (replay) setPendingTerminal(replay);

          // FIX: Check if focus is already on the formula bar (data-formula-bar)
          // If it is, DO NOT steal focus. Let the user type in the formula bar.
          const activeElement = document.activeElement;
          if (activeElement?.getAttribute("data-formula-bar") === "true") {
            console.log("[InlineEditor] Formula bar active, skipping autofocus");
            // Still clear the prevent flag - focus is stable on formula bar
            preventBlurCommit = false;
            return;
          }

          inputRef.current.focus();
          // FIX: Place cursor at tracked position instead of always at end
          // This preserves cursor position after reference insertions mid-formula
          const cursorPos = getGlobalCursorPosition();
          const len = inputRef.current.value.length;
          const pos = Math.min(cursorPos, len);
          inputRef.current.setSelectionRange(pos, pos);
          console.log("[InlineEditor] Focused input, cursor at position:", pos);

          // FIX: Clear the prevent flag AFTER focus is restored
          // This prevents blur from committing during the race between
          // event handlers and the setTimeout focus restoration.
          preventBlurCommit = false;
        }
      }, 0);

    return () => clearTimeout(timeoutId);
  }, [editing.row, editing.col, position.visible, disabled, refocusTrigger]);

  // Don't render the inline editor if we're viewing a different sheet than the source.
  // This happens during cross-sheet formula reference selection (point mode).
  // The formula bar still shows the formula, but we don't overlay the editor on the target sheet.
  // This matches Excel behavior where you see the target sheet clearly while selecting references.
  const isOnDifferentSheet = 
    editing.sourceSheetIndex !== undefined && 
    editing.sourceSheetIndex !== currentSheetIndex;

  // Don't render if not visible OR if viewing a different sheet during formula mode
  // NOTE: This check must be AFTER all hooks to avoid React hooks rule violation
  if (!position.visible || isOnDifferentSheet) {
    return null;
  }

  return (
    <S.EditorTextArea
      ref={inputRef}
      rows={1}
      // Stable hook for tests and for anything that must find the live editor
      // in the DOM. styled-components hashes the class name, so `[class*=...]`
      // does not work here (the same trap documented for E2E dialog
      // selectors); the editor is otherwise an anonymous <input> among the
      // formula bar and the Name Box.
      data-inline-editor="true"
      $x={position.x}
      $y={position.y}
      $width={position.width}
      $height={position.height}
      // Device px already — `baseHeight` is post-zoom, and the border the line
      // height is netted against is a flat 2px at any zoom.
      $lineHeight={editorLineHeight(baseHeight)}
      $zoom={zoom}
      value={editing.value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onSelect={handleSelect}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
    />
  );
  // NOTE: `data-inline-editor` is what E2E and anything else locates the editor
  // with — deliberately an attribute rather than a tag, which is why swapping
  // <input> for <textarea> did not move a single selector.
}

export default InlineEditor;