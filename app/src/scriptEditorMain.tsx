//! FILENAME: app/src/scriptEditorMain.tsx
// PURPOSE: React entry point for the Advanced Script Editor window.
// CONTEXT: This is a standalone Vite entry point for the second Tauri window.
//          It does NOT load Shell, GridProvider, or ThemeRoot -- just the editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { MonacoEditorApp } from "../extensions/ScriptEditor/components/MonacoEditorApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MonacoEditorApp />
  </React.StrictMode>,
);
