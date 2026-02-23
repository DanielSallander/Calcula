//! FILENAME: app/src/shell/Layout.tsx
// PURPOSE: Main application layout (the "Shell")
// CONTEXT: Arranges menu bar, ribbon, formula bar, spreadsheet, sheet tabs, status bar, and task pane.
// All feature-specific logic lives in extensions; the shell only renders generic zones.
// REFACTOR: Extensions are now loaded dynamically via ExtensionManager (no hard imports).

import React, { useEffect } from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { FormulaBar } from "./FormulaBar";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { SheetTabs } from "./SheetTabs";
import { TaskPaneContainer } from "./TaskPane";
import { DialogContainer } from "./DialogContainer";
import { OverlayContainer } from "./OverlayContainer";
import { GridContextMenuHost } from "./Overlays/GridContextMenuHost";
import { ToastContainer } from "./Toast/Toast";
// GridProvider is a special case - it's the root React context that must wrap everything
import { GridProvider } from "../core/state/GridContext";
// Actions and hooks are imported from the API layer
import {
  useGridContext,
  setFreezeConfig,
  ExtensionRegistry,
  AppEvents,
  onAppEvent,
} from "../api";
// Extension management
import { useExtensionInitializer, useExtensions } from "./hooks/useExtensions";
// Hook-based menus that need to be rendered inside React tree
import { StandardMenus } from "../../extensions/BuiltIn/StandardMenus/StandardMenus";

/**
 * Loading screen shown while extensions are initializing.
 */
function LoadingScreen(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        width: "100vw",
        backgroundColor: "#f5f5f5",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: "24px",
          fontWeight: 600,
          color: "#217346",
          marginBottom: "16px",
        }}
      >
        Calcula
      </div>
      <div style={{ fontSize: "14px", color: "#666" }}>Loading extensions...</div>
    </div>
  );
}

/**
 * Error screen shown if extension initialization fails.
 */
function ErrorScreen({ error }: { error: Error }): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        width: "100vw",
        backgroundColor: "#fff5f5",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: "24px",
          fontWeight: 600,
          color: "#c00",
          marginBottom: "16px",
        }}
      >
        Initialization Error
      </div>
      <div style={{ fontSize: "14px", color: "#666", maxWidth: "400px", textAlign: "center" }}>
        {error.message}
      </div>
    </div>
  );
}

/**
 * Inner layout component that has access to GridContext.
 */
function LayoutInner(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const { activeCount, errorCount } = useExtensions();

  // Bridge: notify extensions whenever the grid selection changes.
  useEffect(() => {
    ExtensionRegistry.notifySelectionChange(state.selection);
  }, [state.selection]);

  // Bridge: sync freeze pane state from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      freezeRow: number | null;
      freezeCol: number | null;
    }>(AppEvents.FREEZE_CHANGED, (detail) => {
      dispatch(setFreezeConfig(detail.freezeRow, detail.freezeCol));
    });
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
      {/* Hook-based menus (renders nothing, just activates hooks) */}
      <StandardMenus />

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
          justifyContent: "space-between",
          padding: "0 12px",
          fontSize: "12px",
          color: "#ffffff",
        }}
      >
        <span>Ready</span>
        <span style={{ opacity: 0.8 }}>
          Extensions: {activeCount} active{errorCount > 0 ? `, ${errorCount} error` : ""}
        </span>
      </div>

      {/* Dynamic Dialogs from DialogExtensions (registered by extensions) */}
      <DialogContainer />

      {/* Dynamic Overlays from OverlayExtensions */}
      <OverlayContainer />

      {/* Grid Context Menu - Shell handles rendering, Core emits events */}
      <GridContextMenuHost />

      {/* Toast Notifications */}
      <ToastContainer />
    </div>
  );
}

/**
 * Main Layout component with extension initialization.
 */
export function Layout(): React.ReactElement {
  const { isLoading, error } = useExtensionInitializer();

  // Show loading screen while extensions initialize
  if (isLoading) {
    return <LoadingScreen />;
  }

  // Show error screen if initialization failed
  if (error) {
    return <ErrorScreen error={error} />;
  }

  // Render the full layout once extensions are ready
  return (
    <GridProvider>
      <LayoutInner />
    </GridProvider>
  );
}