//! FILENAME: app/src/shell/Layout.tsx
// PURPOSE: Main application layout (the "Shell")
// CONTEXT: Arranges menu bar, ribbon, formula bar, spreadsheet, sheet tabs, status bar, and task pane.
// All feature-specific logic lives in extensions; the shell only renders generic zones.

import React, { useEffect } from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { FormulaBar } from "./FormulaBar";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { SheetTabs } from "./SheetTabs";
import { TaskPaneContainer } from "./task-pane";
import { DialogContainer } from "./DialogContainer";
import { OverlayContainer } from "./OverlayContainer";
import { GridProvider, useGridContext } from "../core/state/GridContext";
import { setFreezeConfig } from "../core/state/gridActions";
import { ExtensionRegistry, AppEvents, onAppEvent } from "../api";

/**
 * Inner layout component that has access to GridContext.
 */
function LayoutInner(): React.ReactElement {
  const { state, dispatch } = useGridContext();

  // Bridge: notify extensions whenever the grid selection changes.
  // This allows any extension to react to selection changes via
  // ExtensionRegistry.onSelectionChange() without coupling to React state.
  useEffect(() => {
    ExtensionRegistry.notifySelectionChange(state.selection);
  }, [state.selection]);

  // Bridge: sync freeze pane state from API events into Core state.
  // Extensions call api/grid.ts freezePanes() which emits FREEZE_CHANGED.
  // The Shell listens here and dispatches to Core state (Inversion of Control).
  useEffect(() => {
    const cleanup = onAppEvent<{ freezeRow: number | null; freezeCol: number | null }>(
      AppEvents.FREEZE_CHANGED,
      (detail) => {
        dispatch(setFreezeConfig(detail.freezeRow, detail.freezeCol));
      }
    );
    return cleanup;
  }, [dispatch]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: "#ffffff",
      }}
    >
      {/* Menu Bar */}
      <MenuBar />

      {/* Ribbon Area */}
      <RibbonContainer />

      {/* Formula Bar */}
      <FormulaBar />

      {/* Main Content Area - Spreadsheet + Task Pane */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Spreadsheet Area - full width, task pane floats over it */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Spreadsheet />
        </div>

        {/* Task Pane - floats over the spreadsheet */}
        <TaskPaneContainer />
      </div>

      {/* Sheet Tabs */}
      <SheetTabs />

      {/* Status Bar */}
      <div
        style={{
          height: "24px",
          backgroundColor: "#217346",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          fontSize: "12px",
          color: "#ffffff",
        }}
      >
        Ready
      </div>

      {/* Dynamic Dialogs from DialogExtensions */}
      <DialogContainer />

      {/* Dynamic Overlays from OverlayExtensions */}
      <OverlayContainer />
    </div>
  );
}

export function Layout(): React.ReactElement {
  return (
    <GridProvider>
      <LayoutInner />
    </GridProvider>
  );
}
