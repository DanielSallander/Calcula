//! FILENAME: app/src/objectScriptMain.tsx
// PURPOSE: React entry point for the Object Script Editor window.
// CONTEXT: This is a standalone Vite entry point for a separate Tauri window.
//          It does NOT load Shell, GridProvider, or ThemeRoot -- just the editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { ObjectScriptEditorApp } from "../extensions/ScriptableObjects/components/ObjectScriptEditorApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ObjectScriptEditorApp />
  </React.StrictMode>,
);
