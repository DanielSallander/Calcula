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
import { ActivityBar, SidePanel } from "./ActivityBar";
import { DialogContainer } from "./DialogContainer";
import { OverlayContainer } from "./OverlayContainer";
import { GridContextMenuHost } from "./Overlays/GridContextMenuHost";
import { ToastContainer } from "./Toast/Toast";
import { StatusBar } from "./StatusBar";
// GridProvider is a special case - it's the root React context that must wrap everything
import { GridProvider } from "../core/state/GridContext";
// Actions and hooks are imported from the API layer
import {
  useGridContext,
  setFreezeConfig,
  setSplitConfig,
  setViewMode,
  setShowFormulas,
  setDisplayZeros,
  setDisplayGridlines,
  setDisplayHeadings,
  setDisplayFormulaBar,
  ExtensionRegistry,
  AppEvents,
  onAppEvent,
  emitAppEvent,
} from "../api";
import { updateWindowTitle, isFileModified, saveFile } from "../core/lib/file-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ViewMode } from "../core/types";
// Extension management
import { useExtensionInitializer, useExtensions } from "./hooks/useExtensions";
// Hook-based menus that need to be rendered inside React tree
import { StandardMenus } from "../../extensions/BuiltIn/StandardMenus/StandardMenus";
// DEV ONLY: Mock data loader for testing - remove these imports when done testing
import { loadMockData, shouldLoadMockData } from "./utils/mockData";

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

  // Bridge: sync split window state from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      splitRow: number | null;
      splitCol: number | null;
    }>(AppEvents.SPLIT_CHANGED, (detail) => {
      dispatch(setSplitConfig(detail.splitRow, detail.splitCol));
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync view mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      viewMode: ViewMode;
    }>(AppEvents.VIEW_MODE_CHANGED, (detail) => {
      dispatch(setViewMode(detail.viewMode));
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync show formulas mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      showFormulas: boolean;
    }>(AppEvents.SHOW_FORMULAS_TOGGLED, (detail) => {
      dispatch(setShowFormulas(detail.showFormulas));
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display zeros mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayZeros: boolean;
    }>(AppEvents.DISPLAY_ZEROS_TOGGLED, (detail) => {
      dispatch(setDisplayZeros(detail.displayZeros));
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display gridlines mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayGridlines: boolean;
    }>(AppEvents.DISPLAY_GRIDLINES_TOGGLED, (detail) => {
      dispatch(setDisplayGridlines(detail.displayGridlines));
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display headings mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayHeadings: boolean;
    }>(AppEvents.DISPLAY_HEADINGS_TOGGLED, (detail) => {
      dispatch(setDisplayHeadings(detail.displayHeadings));
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display formula bar mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayFormulaBar: boolean;
    }>(AppEvents.DISPLAY_FORMULA_BAR_TOGGLED, (detail) => {
      dispatch(setDisplayFormulaBar(detail.displayFormulaBar));
    });
    return cleanup;
  }, [dispatch]);

  // Window title tracking: update on cells-updated, rows/cols inserted/deleted, and dirty state changes.
  useEffect(() => {
    // Set initial title on mount
    updateWindowTitle();

    const cleanups = [
      onAppEvent(AppEvents.CELLS_UPDATED, () => updateWindowTitle()),
      onAppEvent(AppEvents.ROWS_INSERTED, () => updateWindowTitle()),
      onAppEvent(AppEvents.ROWS_DELETED, () => updateWindowTitle()),
      onAppEvent(AppEvents.COLUMNS_INSERTED, () => updateWindowTitle()),
      onAppEvent(AppEvents.COLUMNS_DELETED, () => updateWindowTitle()),
      onAppEvent(AppEvents.DIRTY_STATE_CHANGED, () => updateWindowTitle()),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, []);

  // Window close handler: emit BEFORE_CLOSE and prompt for unsaved changes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        // Emit BEFORE_CLOSE so extensions can prepare (e.g., persist state)
        emitAppEvent(AppEvents.BEFORE_CLOSE);

        // Check for unsaved changes and prompt the user
        try {
          const dirty = await isFileModified();
          if (dirty) {
            const shouldSave = await ask(
              "Do you want to save changes before closing?",
              {
                title: "Calcula",
                kind: "warning",
                okLabel: "Save",
                cancelLabel: "Don't Save",
              }
            );

            if (shouldSave) {
              await saveFile();
            }
          }
        } catch (error) {
          // If checking dirty state or saving fails, still allow close
          console.error("[Layout] Error during close handler:", error);
        }
        // Don't call event.preventDefault() — let the window close naturally
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // DEV ONLY: Load mock data on mount if environment variable is set
  // DELETE THIS BLOCK when done testing
  useEffect(() => {
    if (shouldLoadMockData()) {
      // Small delay to ensure grid is fully initialized
      const timer = setTimeout(() => {
        loadMockData().catch((error) => {
          console.error("[Layout] Failed to load mock data:", error);
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

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

      {/* Formula Bar (hidden when displayFormulaBar is false) */}
      {state.displayFormulaBar !== false && <FormulaBar />}

      {/* Main Content Area - Activity Bar + Side Panel + Spreadsheet + Task Pane */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Activity Bar - thin icon strip on the left */}
        <ActivityBar />

        {/* Side Panel - expandable panel next to Activity Bar */}
        <SidePanel />

        {/* Spreadsheet Area - fills remaining space */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Spreadsheet />
        </div>

        {/* Task Pane - floats over the spreadsheet on the right */}
        <TaskPaneContainer />
      </div>

      {/* Sheet Tabs */}
      <SheetTabs />

      {/* Status Bar */}
      <StatusBar activeCount={activeCount} errorCount={errorCount} />

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