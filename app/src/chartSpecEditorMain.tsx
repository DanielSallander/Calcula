//! FILENAME: app/src/chartSpecEditorMain.tsx
// PURPOSE: React entry point for the Chart Spec Editor window.
// CONTEXT: Standalone Vite entry point for the chart spec editor Tauri window.
//          Does NOT load Shell, GridProvider, or ThemeRoot -- just the spec editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { ChartSpecEditorApp } from "../extensions/Charts/components/ChartSpecEditorApp";

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary surface="Chart Spec Editor">
    <React.StrictMode>
      <ChartSpecEditorApp />
    </React.StrictMode>
  </RootErrorBoundary>,
);
