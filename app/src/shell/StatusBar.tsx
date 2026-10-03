//! FILENAME: app/src/shell/StatusBar.tsx
// PURPOSE: Status bar component at the bottom of the application.
// CONTEXT: Renders the grid's MODE readout and the selection summary on the
//          left, extension items on the right (including the zoom slider
//          registered by the ZoomSlider extension). Painted with the
//          --status-bar-bg / --status-bar-fg tokens (Calcula Clusters).

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

/**
 * The left zone may SHRINK below its content (minWidth 0), and only the two
 * TEXT slots give way inside it: each truncates to an ellipsis on one line.
 * Registered items keep their natural width (a flex item's default min-width
 * is its content), so no text can squeeze one, wrap it, or push it past the
 * bar's clipped right edge.
 *
 * That matters because the mode slot is not host text alone. Application.
 * StatusBar puts a SCRIPT's message there -- up to 512 characters, at the
 * unlocked tier, no capability needed (scriptHost/allowlist.ts) -- and the
 * bar has no overflow handling. A script could otherwise write a long enough
 * message to push the item beside it out of view, and that item is the
 * host-drawn code-and-scripts indicator (ScriptableObjects' CodeStatusItem).
 */
const LEFT_ZONE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  minWidth: 0,
};

const TRUNCATED_TEXT_STYLE: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

/**
 * WHICH text gives way first. Equal flex-shrink would split a shortfall in
 * proportion to width, so a busy narrow window cut the five-letter mode word
 * to "Rea…" while the long selection readout kept its full width -- and Excel
 * never truncates its mode indicator. So:
 * - the host's own MODE word never shrinks;
 * - a SCRIPT's message (Application.StatusBar) gives way first and hardest;
 * - the selection readout gives way only after that.
 */
const HOST_MODE_STYLE: React.CSSProperties = { ...TRUNCATED_TEXT_STYLE, flexShrink: 0 };
const SCRIPT_MESSAGE_STYLE: React.CSSProperties = { ...TRUNCATED_TEXT_STYLE, flexShrink: 1 };
const SELECTION_STYLE: React.CSSProperties = {
  ...TRUNCATED_TEXT_STYLE,
  flexShrink: 1,
  // Digits of one width: moving from B4 to B8 does not nudge what follows.
  fontVariantNumeric: "tabular-nums",
};
/**
 * While a script's message shows, the selection readout does not shrink AT
 * ALL. Flexbox shares a shortfall in proportion, never in sequence, so even a
 * heavily weighted message left the readout a fraction of a pixel short -- and
 * a fraction is enough to draw its ellipsis ("Col:…", measured live
 * 2026-10-03). With the readout fixed, the message alone gives way, down to
 * nothing; at the 800px minimum window the readout and the items still fit.
 */
const SELECTION_BESIDE_MESSAGE_STYLE: React.CSSProperties = { ...SELECTION_STYLE, flexShrink: 0 };

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
      // Tokens with their light baselines as fallbacks: Light renders exactly
      // the Excel green / white it always did (the goldens hold), Dark gets
      // --status-bar-bg's deeper green, and a skin may repaint either.
      style={{
        height: "24px",
        backgroundColor: "var(--status-bar-bg, #217346)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 12px",
        fontSize: "12px",
        color: "var(--status-bar-fg, #ffffff)",
      }}
    >
      {/* Left zone */}
      <div data-testid="status-bar-left" style={LEFT_ZONE_STYLE}>
        {/* The MODE slot. `customText` is Application.StatusBar's message and
            REPLACES the mode while it is set, exactly as it does in Excel.

            This is the bar's one long-standing left label rather than a
            registered item: a registered item can only be appended BESIDE this
            span (the left zone renders it first), so the mode would have to be
            printed a second time next to a "Ready" that no longer means
            anything. The registry is also the wrong owner -- an item is
            registered by an extension, while the mode is grid state that Core
            computes and announces.

            Truncated rather than wrapped (LEFT_ZONE_STYLE); a truncated
            message keeps its whole text on hover. */}
        <span
          data-testid="status-bar-mode"
          style={customText !== null ? SCRIPT_MESSAGE_STYLE : HOST_MODE_STYLE}
          title={customText ?? undefined}
        >
          {customText ?? modeLabel(gridStatus.mode)}
        </span>
        {gridStatus.selectionText && (
          <span
            data-testid="status-bar-selection"
            style={customText !== null ? SELECTION_BESIDE_MESSAGE_STYLE : SELECTION_STYLE}
            title={gridStatus.selectionText}
          >
            {gridStatus.selectionText}
          </span>
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
