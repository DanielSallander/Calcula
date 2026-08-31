//! FILENAME: app/src/packageInspectorMain.tsx
// PURPOSE: React entry point for the Application Inspector window (standalone
//          read-only .calp application browser). Does NOT load Shell or
//          GridProvider — just the inspector app.
// NAME:    The FILENAME still says "package" on purpose. It is the entry point
//          named by `packageInspector.html`, whose Tauri window LABEL is
//          `"package-inspector"` — the string `capabilities/package-inspector.json`
//          grants permissions to. That label is a contract; the window's TITLE
//          and everything the user reads say "Application Inspector".

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { ApplicationInspectorApp } from "../extensions/Distribution/components/inspector/ApplicationInspectorApp";

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary surface="Application Inspector">
    <React.StrictMode>
      <ApplicationInspectorApp />
    </React.StrictMode>
  </RootErrorBoundary>,
);
