//! FILENAME: app/src/shell/Layout.tsx
// PURPOSE: Main application layout (the "Shell")
// CONTEXT: Arranges menu bar, ribbon, formula bar, spreadsheet, sheet tabs, status bar, and task pane.
// All feature-specific logic lives in extensions; the shell only renders generic zones.
// REFACTOR: Extensions are now loaded dynamically via ExtensionManager (no hard imports).

import React, { useEffect, useReducer } from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { FormulaBar } from "./FormulaBar";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { persistSheetDisplayFlags } from "../core/lib/sheetViewState";
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
  setReferenceStyle,
  ExtensionRegistry,
  AppEvents,
  onAppEvent,
  emitAppEvent,
  checkLifecycleGuards,
} from "../api";
import {
  updateWindowTitle,
  isFileModified,
  saveFile,
  getCurrentFilePath,
} from "../core/lib/file-api";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
// The close prompt goes through the sanctioned dialog wrapper, never the
// plugin's raw `message` (lint-banned outside src/core/lib/dialogs.ts). It
// asks Excel's THREE-button question -- Save / Don't Save / Cancel -- because
// only an explicit "Don't Save" may discard: X, Escape and a failure to ask
// all keep the window open.
import { askSaveDiscardCancelAsync } from "../api/dialogs";
import type { ViewMode } from "../core/types";
// Extension management
import { useExtensionInitializer, useExtensions } from "./hooks/useExtensions";
// Hook-based menus that need to be rendered inside React tree
import { getShellComponents, onShellComponentsChange } from "../api/ui";

/**
 * Renders every extension-registered shell-region component (e.g. StandardMenus'
 * hook-driven File/View/Insert menus). Replaces the former hard import of the
 * StandardMenus extension component — the shell no longer imports app/extensions.
 * Re-renders when the registry changes so a component that registers after mount
 * (during extension activation) still appears.
 */
function ShellComponentHost(): React.ReactElement {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onShellComponentsChange(forceUpdate), []);
  return (
    <>
      {getShellComponents().map(({ id, component: Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}
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
        backgroundColor: "var(--panel-bg)",
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
      <div style={{ fontSize: "14px", color: "var(--text-secondary)" }}>Loading extensions...</div>
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
        backgroundColor: "var(--panel-bg)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: "24px",
          fontWeight: 600,
          color: "var(--text-error)",
          marginBottom: "16px",
        }}
      >
        Initialization Error
      </div>
      <div style={{ fontSize: "14px", color: "var(--text-secondary)", maxWidth: "400px", textAlign: "center" }}>
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
      // Persist: before this the flag was frontend-only and reset on every reload
      // and every sheet switch.
      void persistSheetDisplayFlags({ viewMode: detail.viewMode });
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync show formulas mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      showFormulas: boolean;
    }>(AppEvents.SHOW_FORMULAS_TOGGLED, (detail) => {
      dispatch(setShowFormulas(detail.showFormulas));
      void persistSheetDisplayFlags({ showFormulas: detail.showFormulas });
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display zeros mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayZeros: boolean;
    }>(AppEvents.DISPLAY_ZEROS_TOGGLED, (detail) => {
      dispatch(setDisplayZeros(detail.displayZeros));
      void persistSheetDisplayFlags({ displayZeros: detail.displayZeros });
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display gridlines mode from API events into Core state.
  // Persists the per-sheet setting to the Rust backend.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayGridlines: boolean;
    }>(AppEvents.DISPLAY_GRIDLINES_TOGGLED, (detail) => {
      dispatch(setDisplayGridlines(detail.displayGridlines));
      invoke("set_show_gridlines", { visible: detail.displayGridlines }).catch(() => {});
    });
    return cleanup;
  }, [dispatch]);

  // Bridge: sync display headings mode from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      displayHeadings: boolean;
    }>(AppEvents.DISPLAY_HEADINGS_TOGGLED, (detail) => {
      dispatch(setDisplayHeadings(detail.displayHeadings));
      void persistSheetDisplayFlags({ displayHeadings: detail.displayHeadings });
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

  // Bridge: sync reference style from API events into Core state.
  useEffect(() => {
    const cleanup = onAppEvent<{
      referenceStyle: "A1" | "R1C1";
    }>(AppEvents.REFERENCE_STYLE_CHANGED, (detail) => {
      dispatch(setReferenceStyle(detail.referenceStyle));
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

  // Window close handler: ask the close guards, then -- over unsaved changes --
  // Save / Don't Save / Cancel, and broadcast BEFORE_CLOSE only once the close
  // is DECIDED.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // `onCloseRequested` registers ASYNCHRONOUSLY, so a cleanup that runs before the
    // promise resolves cannot cancel it through `unlisten` -- it is still undefined.
    // React StrictMode mounts this effect twice in dev, so the FIRST registration
    // survived its own cleanup and the window ended up with TWO close handlers.
    // Both then ran on the same close request, and both tried to raise the native
    // save prompt: the second `ask()` cannot open a modal while the first owns one,
    // so it rejected, the catch below swallowed the rejection, and the handler fell
    // through to `destroy()` -- tearing the window down while the prompt was still on
    // screen and discarding the user's unsaved work. `cancelled` closes that race by
    // unlistening a registration that resolved after its effect was torn down.
    let cancelled = false;
    // Re-entrancy guard: a second close request arriving while the prompt is up must
    // not stack a second modal.
    let prompting = false;

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        // Cancellable Before-Close. This MUST come first: BEFORE_CLOSE is what
        // tears the script realm down (ScriptableObjects unmounts every script
        // on it), so a script asked after the broadcast could never answer.
        // A guard that hangs or crashes cannot trap the user in the app — the
        // script host bounds each verdict and defaults to ALLOW.
        // checkLifecycleGuards reports the cancellation to the user itself.
        if (await checkLifecycleGuards("close")) {
          event.preventDefault();
          return;
        }

        // BEFORE_CLOSE is not a notice that a close was REQUESTED; it is the
        // workbook's teardown. On it every object script is unmounted (and with
        // it every onBeforeClose / onBeforeSave veto its host registered), the
        // scheduler stops, script panes and forms close and drop pending bound
        // text, capability grants are forgotten, a macro recording ends and the
        // Animation driver unloads -- and nothing re-establishes any of that
        // short of reopening the file. So it goes out only on a path that really
        // closes the window. It used to go out HERE, ahead of the question, and
        // Cancel / X / Escape then left the window open over a workbook whose
        // scripts were all gone.

        // Check for unsaved changes and prompt the user
        let dirty = false;
        try {
          dirty = await isFileModified();
        } catch {
          // If check fails, allow close
        }

        if (!dirty) {
          // Nothing to ask: the window closes natively once this returns.
          emitAppEvent(AppEvents.BEFORE_CLOSE);
          return;
        }

        // Prevent close while we show the dialog
        event.preventDefault();

        if (prompting) return;
        prompting = true;

        // Three buttons, as in Excel. The two-button box this replaced read
        // X and Escape as its refusing button, "Don't Save", and destroyed
        // the window over the unsaved document.
        const answer = await askSaveDiscardCancelAsync(
          "Do you want to save changes before closing?",
          {
            title: "Calcula",
            kind: "warning",
            saveLabel: "Save",
            discardLabel: "Don't Save",
            cancelLabel: "Cancel",
          }
        );
        // Only an explicit Save or Don't Save goes on to close. "cancel" (the
        // Cancel button, X, Escape) and "unavailable" (no answer at all) keep
        // the window open. NEVER fall through to destroy() on those: that
        // discards unsaved work the user did not agree to discard. Keeping the
        // window open costs the user one repeated click; closing costs them
        // the document. Nothing has been torn down on this path.
        if (answer !== "save" && answer !== "discard") {
          if (answer === "unavailable") {
            console.error(
              "[Layout] Could not show the unsaved-changes prompt; keeping the window open."
            );
          }
          prompting = false;
          return;
        }

        if (answer === "save") {
          // Before-Save veto, asked HERE, while the scripts are still mounted.
          // saveFile() asks the same guards, but only after the BEFORE_CLOSE
          // below has unmounted every script and disposed its guard with it, so
          // left to saveFile a script's onBeforeSave ("fill in the total
          // first") never ran on this path, though the same script vetoes a
          // Ctrl+S. Excel fires Workbook_BeforeSave for the close prompt's Save
          // too, and BEFORE the Save As dialog (SaveAsUI) -- hence the untitled
          // workbook is asked as a "saveAs" with no path yet. The detail
          // mirrors saveFile's own. Each script is asked once: by the time
          // saveFile asks again, only the trusted extension guards are left.
          let refused: unknown;
          try {
            const path = await getCurrentFilePath();
            refused = await checkLifecycleGuards(
              "save",
              path ? { path, kind: "save" } : { kind: "saveAs" }
            );
          } catch (error) {
            console.error(
              "[Layout] Could not prepare the save during close; keeping the window open:",
              error
            );
            prompting = false;
            return;
          }
          // A veto keeps everything: the window, the scripts, the document.
          // checkLifecycleGuards has already told the user who refused and why.
          if (refused) {
            prompting = false;
            return;
          }

          // The close is decided. The teardown goes out BEFORE the write, not
          // after it: the macro recorder stores the recording it was taking,
          // the Animation driver restores its transient frame, and the script
          // host re-protects any sheet a script had lifted protection from --
          // all of which belong in the file. (Those subscribers start async
          // work they are not awaited on; the human wait on the old prompt used
          // to hide that. Nothing on this side can await an event.)
          emitAppEvent(AppEvents.BEFORE_CLOSE);

          let savedPath: string | null;
          try {
            savedPath = await saveFile();
          } catch (error) {
            // The save the user asked for failed. Same rule: do not close over
            // unsaved work.
            console.error(
              "[Layout] Save failed during close; keeping the window open:",
              error
            );
            prompting = false;
            return;
          }
          // `null` is saveFile's "not saved": the Save As picker was cancelled
          // (an untitled workbook) or the lossy-save warning was declined. The
          // scripts' Before-Save vetoes were asked above; only a trusted
          // extension guard could refuse in there. Nothing reached disk, so
          // closing now would discard the document exactly as "Don't Save"
          // does. KNOWN RESIDUE: BEFORE_CLOSE has already gone out, so the
          // window stays open over a torn-down script realm. Closing that gap
          // needs saveFile split into "resolve the destination and every
          // consent" and "write", so every step that can still refuse runs
          // before the teardown.
          if (savedPath === null) {
            prompting = false;
            return;
          }
        } else {
          // "Don't Save": the close is decided, nothing is written.
          emitAppEvent(AppEvents.BEFORE_CLOSE);
        }

        // User has responded and any save succeeded — now close
        await getCurrentWindow().destroy();
      })
      .then((fn) => {
        // The effect was already torn down while this registration was in flight:
        // undo it now, or the listener leaks and doubles up on the next mount.
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // DEV ONLY: Load mock data on mount if environment variable is set
  // DELETE THIS BLOCK when done testing
  useEffect(() => {
    if (shouldLoadMockData()) {
      // Don't load mock data if a file is already open (e.g., after window.location.reload() on file open)
      import("../core/lib/file-api").then(({ getCurrentFilePath }) => {
        getCurrentFilePath().then((path) => {
          if (path) {
            console.log("[Layout] File already open, skipping mock data:", path);
            return;
          }
          // Small delay to ensure grid is fully initialized
          setTimeout(() => {
            loadMockData().catch((error) => {
              console.error("[Layout] Failed to load mock data:", error);
            });
          }, 500);
        });
      });
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
        backgroundColor: "var(--bg-surface)",
      }}
    >
      {/* Extension-registered shell-region components (e.g. StandardMenus'
          hook-based File/View/Insert menus) — registered via ctx.ui.shellComponents,
          not hard-imported. */}
      <ShellComponentHost />

      {/* Menu Bar */}
      <MenuBar />

      {/* Ribbon Area */}
      <RibbonContainer />

      {/* Formula Bar (hidden when displayFormulaBar is false) */}
      {state.displayFormulaBar !== false && <FormulaBar />}

      {/* Main Content Area - Activity Bar + Side Panel + Spreadsheet + Task Pane

          overflow: CLIP, not hidden. A closed task pane stays mounted, parked
          at right: -width, so once a pane has been opened this row holds
          320px more content than it shows. `overflow: hidden` still makes the
          row a SCROLL CONTAINER: anything that scrolled an off-screen element
          into view (navigating to a cell past the right edge, focus landing in
          the parked pane) scrolled the whole row sideways, sliding the
          activity rail out on the left and the empty parked pane into view on
          the right, and nothing ever scrolled it back. `clip` paints the same
          and cannot be scrolled at all. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "clip",
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