//! FILENAME: app/src/shell/StatusBar.tsx
// PURPOSE: Status bar component at the bottom of the application.
// CONTEXT: Renders "Ready" text on the left, extension count on the right,
//          and any registered status bar items from extensions.

import React, { useState, useEffect, useCallback } from "react";
import {
  getStatusBarItems,
  subscribeToStatusBar,
  emitAppEvent,
  AppEvents,
  type StatusBarItemDefinition,
} from "../api";

interface StatusBarProps {
  activeCount: number;
  errorCount: number;
}

export function StatusBar({ activeCount, errorCount }: StatusBarProps): React.ReactElement {
  const [items, setItems] = useState<StatusBarItemDefinition[]>(() => getStatusBarItems());

  const refresh = useCallback(() => {
    setItems(getStatusBarItems());
  }, []);

  useEffect(() => {
    return subscribeToStatusBar(refresh);
  }, [refresh]);

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
        <span>Ready</span>
        {leftItems.map((item) => (
          <item.component key={item.id} />
        ))}
      </div>

      {/* Right zone - flex: 1 so extension items can fill available space */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px", flex: 1, justifyContent: "flex-end" }}>
        {rightItems.map((item) => (
          <item.component key={item.id} />
        ))}
        <span style={{ opacity: 0.8 }}>
          Extensions: {activeCount} active{errorCount > 0 ? `, ${errorCount} error` : ""}
        </span>
      </div>
    </div>
  );
}
