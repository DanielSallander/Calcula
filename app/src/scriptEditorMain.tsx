//! FILENAME: app/src/scriptEditorMain.tsx
// PURPOSE: React entry point for the Advanced Script Editor window.
// CONTEXT: This is a standalone Vite entry point for the second Tauri window.
//          It does NOT load Shell, GridProvider, or ThemeRoot -- just the editor.

import React from "react";
import ReactDOM from "react-dom/client";
import { MonacoEditorApp } from "../extensions/ScriptEditor/components/MonacoEditorApp";
import { invokeBackend } from "./api/backend";
import { createScopedInvokeBackend } from "./api/backendCommands";
import { scriptEditorBackend } from "../extensions/ScriptEditor/lib/scriptEditorBackend";

// Bind the ScriptEditor backend channel for THIS window's realm (A3). The
// standalone Monaco editor window does not run ScriptEditor.activate(), so the
// channel must be bound here, before render, for scriptApi.ts to reach the backend.
// First-party trusted window -> trusted=true makes the scoped door a passthrough.
scriptEditorBackend.set(createScopedInvokeBackend(true, invokeBackend));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MonacoEditorApp />
  </React.StrictMode>,
);
