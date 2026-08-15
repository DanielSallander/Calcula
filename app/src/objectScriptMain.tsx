//! FILENAME: app/src/objectScriptMain.tsx
// PURPOSE: React entry point for the Object Script Editor window.
// CONTEXT: This is a standalone Vite entry point for a separate Tauri window.
//          It does NOT load Shell, GridProvider, or ThemeRoot -- just the editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { ObjectScriptEditorApp } from "../extensions/ScriptableObjects/components/ObjectScriptEditorApp";

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary surface="Object Script Editor">
    <React.StrictMode>
      <ObjectScriptEditorApp />
    </React.StrictMode>
  </RootErrorBoundary>,
);
