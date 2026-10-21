//! FILENAME: app/src/chartSpecEditorMain.tsx
// PURPOSE: React entry point for the Chart Spec Editor window.
// CONTEXT: Standalone Vite entry point for the chart spec editor Tauri window.
//          Does NOT load Shell, GridProvider, or ThemeRoot -- just the spec editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { ChartSpecEditorApp } from "../extensions/Charts/components/ChartSpecEditorApp";
import { initAppLocale } from "./api/locale";

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
//
// The app locale is read from Rust BEFORE the first render (P2), so this window
// formats numbers and dates like the main one from its first frame and follows
// locale:changed afterwards. initAppLocale never rejects.
void initAppLocale().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <RootErrorBoundary surface="Chart Spec Editor">
      <React.StrictMode>
        <ChartSpecEditorApp />
      </React.StrictMode>
    </RootErrorBoundary>,
  );
});
