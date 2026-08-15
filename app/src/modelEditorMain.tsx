//! FILENAME: app/src/modelEditorMain.tsx
// PURPOSE: React entry point for the Model Editor window (VBA-style
//          standalone editor). Does NOT load Shell or GridProvider — just the
//          model editor app.

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { ModelEditorApp } from "../extensions/ModelEditor/components/ModelEditorApp";

// This window is created with dragDropEnabled: false so HTML5 drag-and-drop
// works (Tauri's native handler swallows it on Windows) — which also hands OS
// file drops to the DOM, where Chromium's DEFAULT action is to NAVIGATE the
// page to the dropped file, unmounting the editor. Cancel that default
// window-wide; the sanctioned drop zones (measure folders, the Monaco editor)
// handle their own drops independently of this.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary surface="Model Editor">
    <React.StrictMode>
      <ModelEditorApp />
    </React.StrictMode>
  </RootErrorBoundary>,
);
