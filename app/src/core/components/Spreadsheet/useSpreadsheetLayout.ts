//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetLayout.ts
// PURPOSE: Handles visual layout calculations and status bar text.
// CONTEXT: Purely presentational logic for determining what is visible and what to show in the status bar.

import { useEffect, useCallback, useState } from "react";
import { useViewport } from "../../hooks";
import { getEndMode, getExtendMode } from "../../hooks/useGridKeyboard";
import { useGridState } from "../../state";
import { calculateVisibleRange } from "../../lib/gridRenderer";
import { emitAppEvent } from "../../lib/events";
import type { GridCanvasHandle } from "../Grid";

type GridState = ReturnType<typeof useGridState>;

/**
 * The grid's mode readout, announced for whoever paints the status bar.
 *
 * Core computes both halves below and the Shell's StatusBar prints them. An
 * EVENT rather than a return value because Core must not reach into the Shell
 * (Alien Rule); it is the route the grid already uses for `selection:changed`
 * and `dimensions:refresh`.
 *
 * Both halves were computed and thrown away for as long as they have existed:
 * the bar showed a hardcoded "Ready" while the grid knew perfectly well that it
 * was resizing, filling, or sitting in F8 extend mode.
 */
export const GRID_MODE_CHANGED = "grid:mode-changed";

/** Payload of {@link GRID_MODE_CHANGED}. */
export interface GridModeDetail {
  /** The mode indicator, spelled exactly as `getModeStatus` spells it. */
  mode: string;
  /** The selection's reference and size, or null when nothing is selected. */
  selectionText: string | null;
}

interface UseSpreadsheetLayoutProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<GridCanvasHandle | null>;
  state: GridState;
  isFocused: boolean;
  getSelectionReference: () => string;
  mouseCursorStyle: string;
  isResizing: boolean;
  isFormulaDragging: boolean;
  isDragging: boolean;
  isFillDragging?: boolean;
}

export function useSpreadsheetLayout({
  scrollRef,
  containerRef,
  canvasRef,
  state,
  isFocused,
  getSelectionReference,
  mouseCursorStyle,
  isResizing,
  isFormulaDragging,
  isDragging,
  isFillDragging = false,
}: UseSpreadsheetLayoutProps) {
  const { viewport, config, selection, dimensions } = state;
  
  const {
    handleScroll,
    getContentSize,
    getVirtualBounds,
  } = useViewport();

  useEffect(() => {
    if (scrollRef.current) {
      const scrollEl = scrollRef.current;
      if (
        Math.abs(scrollEl.scrollLeft - viewport.scrollX) > 1 ||
        Math.abs(scrollEl.scrollTop - viewport.scrollY) > 1
      ) {
        scrollEl.scrollLeft = viewport.scrollX;
        scrollEl.scrollTop = viewport.scrollY;
      }
    }
  }, [viewport.scrollX, viewport.scrollY, scrollRef]);

  const handleScrollEvent = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      handleScroll(event);
      canvasRef.current?.redraw();
    },
    [handleScroll, canvasRef]
  );

  const contentSize = getContentSize();

  /* eslint-disable react-hooks/refs -- Container dimensions needed for layout calculation with fallback defaults */
  const containerWidth = containerRef.current?.clientWidth || 800;
  const containerHeight = containerRef.current?.clientHeight || 600;
  const visibleRange = calculateVisibleRange(viewport, config, containerWidth, containerHeight, dimensions);
  /* eslint-enable react-hooks/refs */

  const getSelectionSize = (): string => {
    if (!selection) return "";
    const rows = Math.abs(selection.endRow - selection.startRow) + 1;
    const cols = Math.abs(selection.endCol - selection.startCol) + 1;
    if (rows === 1 && cols === 1) return "";
    return `[${rows}R x ${cols}C]`;
  };

  const statusText = selection
    ? `${getSelectionReference()} ${getSelectionSize()} | Row: ${selection.endRow + 1}, Col: ${selection.endCol + 1}`
    : "Ready";

  const bounds = getVirtualBounds();
  const boundsInfo = `Bounds: ${bounds.maxRow + 1}R x ${bounds.maxCol + 1}C`;
  const scrollInfo = `Visible: R${visibleRange.startRow + 1}-${visibleRange.endRow + 1}, C${visibleRange.startCol + 1}-${visibleRange.endCol + 1}`;

  const getModeStatus = (): string => {
    if (isFillDragging) return "[Fill]";
    if (isResizing) return "[Resizing]";
    if (isFormulaDragging) return "[Selecting Ref]";
    if (isDragging) return "[Selecting]";
    if (state.editing) return "[Editing]";
    // Extend outranks End when both are armed: F8 changes what EVERY following
    // arrow key does until it is switched off, while End is spent by the very
    // next keystroke and comes back the moment it is armed again.
    if (getExtendMode()) return "[Extend]";
    if (getEndMode()) return "[End]";
    if (isFocused) return "[Ready]";
    return "[Click to focus]";
  };

  // Extend mode and End mode are MODULE-LEVEL flags in useGridKeyboard, read
  // through getExtendMode/getEndMode. Nothing subscribes to them and no React
  // state stands behind them, so flipping one re-renders nothing at all and the
  // readout would keep saying [Ready] until some unrelated edit repainted the
  // grid. Two details decide the shape of this listener:
  //
  //   * the keydown handler that flips them calls stopPropagation() on F8 and
  //     Escape, so a bubble-phase listener above the grid container never sees
  //     those keys. A CAPTURE listener always does.
  //   * capture runs BEFORE the flip, so the flag is not read here -- a repaint
  //     is scheduled for the next frame instead. Listener ORDER can then never
  //     make the bar photograph the pre-toggle value, which matters because
  //     useGridKeyboard re-registers its listener on every selection change and
  //     so keeps moving to the end of the queue.
  //
  // End mode is armed by End and spent by the NEXT key whatever it is, so an
  // ARMED End mode widens the filter for exactly one keystroke rather than
  // re-rendering the grid on every key the application ever sees.
  const [, repaintModeStatus] = useState(0);
  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      const canFlipAMode =
        event.key === "F8" ||
        event.key === "Escape" ||
        event.key === "End" ||
        getEndMode();
      if (!canFlipAMode) return;
      requestAnimationFrame(() => repaintModeStatus((tick) => tick + 1));
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);

  const modeStatus = getModeStatus();
  // `statusText` says "Ready" when there is no selection, which is the mode
  // indicator's word, not a selection summary -- the bar would print it twice.
  const selectionText = selection ? statusText : null;

  useEffect(() => {
    const detail: GridModeDetail = { mode: modeStatus, selectionText };
    emitAppEvent(GRID_MODE_CHANGED, detail);
  }, [modeStatus, selectionText]);

  const gridCursor = isFillDragging 
    ? "crosshair" 
    : isResizing 
      ? mouseCursorStyle 
      : (mouseCursorStyle !== "default" ? mouseCursorStyle : "cell");

  return {
    contentSize,
    handleScrollEvent,
    statusText,
    scrollInfo,
    boundsInfo,
    getModeStatus,
    gridCursor
  };
}