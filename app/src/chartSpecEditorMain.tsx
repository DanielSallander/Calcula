//! FILENAME: app/src/chartSpecEditorMain.tsx
// PURPOSE: React entry point for the Chart Spec Editor window.
// CONTEXT: Standalone Vite entry point for the chart spec editor Tauri window.
//          Does NOT load Shell, GridProvider, or ThemeRoot -- just the spec editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { ChartSpecEditorApp } from "../extensions/Charts/components/ChartSpecEditorApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChartSpecEditorApp />
  </React.StrictMode>,
);
