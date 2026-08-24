//! FILENAME: app/src/shell/StatusBar.tsx
// PURPOSE: Status bar component at the bottom of the application.
// CONTEXT: Renders the grid's MODE readout and the selection summary on the
//          left, extension items on the right (including the zoom slider
//          registered by the ZoomSlider extension).

import React, { useState, useEffect, useCallback } from "react";
import {
  getStatusBarItems,
  subscribeToStatusBar,
  emitAppEvent,
  onAppEvent,
  AppEvents,
  type StatusBarItemDefinition,
} from "../api";
import {
  GRID_MODE_CHANGED,
  type GridModeDetail,
} from "../core/components/Spreadsheet/useSpreadsheetLayout";

interface StatusBarProps {
  activeCount?: number;
  errorCount?: number;
}

/**
 * The two modes the grid reports while it is merely waiting for input.
 *
 * Both print as "Ready" -- the word this bar has always shown, and the one
 * Excel shows. A status bar whose idle text flips to "[Click to focus]" the
 * moment the window loses focus is noise rather than information, and Excel
 * says "Ready" whether or not its window has focus.
 */
const IDLE_MODES = new Set(["[Ready]", "[Click to focus]"]);

/** What the mode slot prints for a mode Core reported. */
function modeLabel(mode: string): string {
  return IDLE_MODES.has(mode) ? "Ready" : mode;
}

/** The mode assumed before the grid has announced one (or without a grid). */
const IDLE_STATUS: GridModeDetail = { mode: "[Ready]", selectionText: null };

export function StatusBar(_props: StatusBarProps): React.ReactElement {
  const [items, setItems] = useState<StatusBarItemDefinition[]>(() => getStatusBarItems());
  const [customText, setCustomText] = useState<string | null>(null);
  const [gridStatus, setGridStatus] = useState<GridModeDetail>(IDLE_STATUS);

  const refresh = useCallback(() => {
    setItems(getStatusBarItems());
  }, []);

  useEffect(() => {
    return subscribeToStatusBar(refresh);
  }, [refresh]);

  // Listen for custom status bar text from extensions
  useEffect(() => {
    return onAppEvent<{ text: string | null }>(AppEvents.STATUS_BAR_TEXT_CHANGED, (detail) => {
      setCustomText(detail.text);
    });
  }, []);

  // The grid's mode indicator and selection summary. Core computes both
  // (useSpreadsheetLayout's getModeStatus/statusText) and announces them; this
  // bar used to print a hardcoded "Ready" instead, so the F8 extend indicator
  // the grid has always tracked reached nobody.
  useEffect(() => {
    return onAppEvent<GridModeDetail>(GRID_MODE_CHANGED, (detail) => {
      setGridStatus(detail);
    });
  }, []);

  const leftItems = items.filter((item) => item.alignment === "left");
  const rightItems = items.filter((item) => item.alignment === "right");

  // Suppress the browser/WebView context menu and emit an event so that
  // extension widgets (e.g., aggregation) can show their own context menus.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    emitAppEvent(AppEvents.STATUS_BAR_CONTEXT_MENU, { x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div
      data-testid="status-bar"
      onContextMenu={handleContextMenu}
      style={{
        height: "24px",
        backgroundColor: "#217346",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 12px",
        fontSize: "12px",
        color: "#ffffff",
      }}
    >
      {/* Left zone */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {/* The MODE slot. `customText` is Application.StatusBar's message and
            REPLACES the mode while it is set, exactly as it does in Excel.

            This is the bar's one long-standing left label rather than a
            registered item: a registered item can only be appended BESIDE this
            span (the left zone renders it first), so the mode would have to be
            printed a second time next to a "Ready" that no longer means
            anything. The registry is also the wrong owner -- an item is
            registered by an extension, while the mode is grid state that Core
            computes and announces. */}
        <span data-testid="status-bar-mode">{customText ?? modeLabel(gridStatus.mode)}</span>
        {gridStatus.selectionText && (
          <span data-testid="status-bar-selection">{gridStatus.selectionText}</span>
        )}
        {leftItems.map((item) => (
          <item.component key={item.id} />
        ))}
      </div>

      {/* Right zone - flex: 1 so extension items can fill available space */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px", flex: 1, justifyContent: "flex-end" }}>
        {rightItems.map((item) => (
          <item.component key={item.id} />
        ))}
      </div>
    </div>
  );
}
