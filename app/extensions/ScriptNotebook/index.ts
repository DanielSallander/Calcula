//! FILENAME: app/extensions/ScriptNotebook/index.ts
// PURPOSE: Script Notebook extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers the activity sidebar view and Developer menu item.
//          Notebooks provide Jupyter-style multi-cell scripting with shared
//          variables and snapshot-based rewind.

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { IconNotebook, showToast } from "@api";
import { listenTauriEvent } from "@api/backend";
import {
  SCRIPT_DEFERRED_ACTIONS_EVENT,
  normalizeDeferredActions,
} from "@api/workbookScripts";
import { NotebookPanel } from "./components/NotebookPanel";
import { NOTEBOOK_OPEN_EVENT } from "@api/notebookBackend";
import {
  MACRO_TO_NOTEBOOK_EVENT,
  type MacroToNotebookDetail,
} from "@api/lib";
import { notebookBackend } from "./lib/notebookBackend";
import { useNotebookStore } from "./lib/useNotebookStore";
import { applyDeferredActions } from "./lib/deferredActions";
import { liveDeferredActionHost } from "./lib/deferredActionHost";
import {
  NOTEBOOK_SCAFFOLD_EVENT,
  normalizeScaffoldRequest,
  scaffoldCellSource,
} from "./lib/notebookScaffold";

// ============================================================================
// Constants
// ============================================================================

const VIEW_ID = "script-notebook";

// ============================================================================
// Icon
// ============================================================================

// Notebook icon (book with cells)
const NotebookIcon = React.createElement(
  "svg",
  {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  // Book outline
  React.createElement("rect", {
    x: 4,
    y: 2,
    width: 16,
    height: 20,
    rx: 2,
  }),
  // Spine
  React.createElement("line", { x1: 8, y1: 2, x2: 8, y2: 22 }),
  // Cell dividers
  React.createElement("line", { x1: 8, y1: 8, x2: 20, y2: 8 }),
  React.createElement("line", { x1: 8, y1: 14, x2: 20, y2: 14 }),
  // Play triangle in first cell
  React.createElement("path", { d: "M12 4.5l3 1.5-3 1.5V4.5", fill: "currentColor", stroke: "none" }),
);

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[ScriptNotebook] Already activated, skipping.");
    return;
  }

  console.log("[ScriptNotebook] Activating...");

  // Bind the capability-scoped backend door before any code can trigger a
  // backend call (lib-api/store/components route through this channel) (A3).
  notebookBackend.set(context.invokeBackend);

  // 1. Register activity sidebar view
  context.ui.activityBar.register({
    id: VIEW_ID,
    title: "Notebook",
    icon: NotebookIcon,
    component: NotebookPanel,
    priority: 45,
  });
  cleanupFns.push(() => context.ui.activityBar.unregister(VIEW_ID));

  // 2. Register the Developer menu (previously owned by ScriptEditor)
  context.ui.menus.register({
    id: "developer",
    label: "Developer",
    order: 90,
    items: [
      {
        id: "developer:notebook",
        label: "Notebook",
        icon: IconNotebook,
        action: () => {
          context.ui.activityBar.toggle(VIEW_ID);
        },
      },
    ],
  });

  // 2b. Data menu entry — the notebook is an ANALYSIS workbench, so it belongs
  //     next to the other data tools, not only under Developer. The Developer
  //     container above stays registered (AIChat + Controls inject into it).
  context.ui.menus.registerItem("data", {
    id: "data:notebook",
    label: "Notebook",
    icon: IconNotebook,
    order: 70,
    action: () => {
      context.ui.activityBar.toggle(VIEW_ID);
    },
  });

  // 3. Keyboard shortcut: Ctrl+Shift+N to toggle notebook
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "N") {
      e.preventDefault();
      context.ui.activityBar.toggle(VIEW_ID);
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() =>
    window.removeEventListener("keydown", handleKeyDown, true),
  );

  // 4. Listen for deferred actions from script execution — the whole
  //    DeferredAction vocabulary (navigation, view/display toggles, fills,
  //    named styles, scroll area, iteration settings, sheet visibility).
  //    Any script surface can raise these; the payload is re-validated here
  //    because it arrives as an untyped CustomEvent detail.
  const handleDeferredActions = (e: Event) => {
    const actions = normalizeDeferredActions((e as CustomEvent).detail);
    if (actions.length === 0) return;
    void applyDeferredActions(actions, liveDeferredActionHost);
  };
  window.addEventListener(SCRIPT_DEFERRED_ACTIONS_EVENT, handleDeferredActions);
  cleanupFns.push(() =>
    window.removeEventListener(SCRIPT_DEFERRED_ACTIONS_EVENT, handleDeferredActions),
  );

  // 5. Open a notebook on request from other extensions (e.g. FileExplorer),
  //    which dispatch via @api requestOpenNotebook() instead of importing our store.
  const handleOpenNotebook = (e: Event) => {
    const id = (e as CustomEvent).detail?.id;
    if (typeof id !== "string") return;
    void useNotebookStore.getState().openNotebook(id);
  };
  window.addEventListener(NOTEBOOK_OPEN_EVENT, handleOpenNotebook);
  cleanupFns.push(() => window.removeEventListener(NOTEBOOK_OPEN_EVENT, handleOpenNotebook));

  // 6. "Record into a cell": the macro recorder hands us generated source over
  //    the @api event channel (siblings may not import each other). A notebook
  //    is created on the fly when none is open, so the recorder never has to
  //    know anything about notebook lifecycle.
  const handleMacroSource = (e: Event) => {
    const detail = (e as CustomEvent).detail as Partial<MacroToNotebookDetail> | undefined;
    if (!detail || typeof detail.source !== "string" || detail.source.length === 0) return;
    const name = typeof detail.name === "string" && detail.name ? detail.name : "Recorded macros";
    void (async () => {
      try {
        if (!useNotebookStore.getState().activeNotebook) {
          await useNotebookStore.getState().createNotebook(name);
        }
        useNotebookStore.getState().appendCellWithSource(detail.source as string);
        context.ui.activityBar.open(VIEW_ID);
      } catch (err) {
        console.error("[ScriptNotebook] Failed to add recorded macro cell:", err);
      }
    })();
  };
  window.addEventListener(MACRO_TO_NOTEBOOK_EVENT, handleMacroSource);
  cleanupFns.push(() =>
    window.removeEventListener(MACRO_TO_NOTEBOOK_EVENT, handleMacroSource),
  );

  // 7. "Test in notebook" scaffolds (Model Editor). A CROSS-WINDOW Tauri event,
  //    because the Model Editor is its own window and a DOM CustomEvent cannot
  //    reach us there. The payload only becomes CELL SOURCE — text in an editor.
  //    It is never executed on arrival: cells run when the user runs them, and a
  //    model.* call inside one still meets the notebook's own consent gate. The
  //    payload is re-validated (untyped IPC) and capped before it is stored.
  let unlistenScaffold: (() => void) | null = null;
  void listenTauriEvent(NOTEBOOK_SCAFFOLD_EVENT, (payload) => {
    const request = normalizeScaffoldRequest(payload);
    if (!request) return;
    void (async () => {
      try {
        if (!useNotebookStore.getState().activeNotebook) {
          await useNotebookStore.getState().createNotebook(request.notebookName);
        }
        useNotebookStore
          .getState()
          .appendCellsWithSource(request.cells.map(scaffoldCellSource));
        context.ui.activityBar.open(VIEW_ID);
        showToast(`${request.title} — added to the notebook`, { type: "info" });
      } catch (err) {
        console.error("[ScriptNotebook] Failed to apply notebook scaffold:", err);
      }
    })();
  }).then((off) => {
    unlistenScaffold = off;
  });
  cleanupFns.push(() => {
    unlistenScaffold?.();
    unlistenScaffold = null;
  });

  isActivated = true;
  console.log("[ScriptNotebook] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[ScriptNotebook] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ScriptNotebook] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log("[ScriptNotebook] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.script-notebook",
    name: "Script Notebook",
    version: "1.0.0",
    description: "Jupyter-style multi-cell scripting with shared variables and snapshot-based rewind.",
  },
  activate,
  deactivate,
};

export default extension;
