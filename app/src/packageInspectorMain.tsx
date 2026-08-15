//! FILENAME: app/src/packageInspectorMain.tsx
// PURPOSE: React entry point for the Package Inspector window (standalone
//          read-only .calp package browser). Does NOT load Shell or
//          GridProvider — just the inspector app.

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { PackageInspectorApp } from "../extensions/Distribution/components/inspector/PackageInspectorApp";

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary surface="Package Inspector">
    <React.StrictMode>
      <PackageInspectorApp />
    </React.StrictMode>
  </RootErrorBoundary>,
);
