//! FILENAME: app/src/packageInspectorMain.tsx
// PURPOSE: React entry point for the Package Inspector window (standalone
//          read-only .calp package browser). Does NOT load Shell or
//          GridProvider — just the inspector app.

import React from "react";
import ReactDOM from "react-dom/client";
import { PackageInspectorApp } from "../extensions/Distribution/components/inspector/PackageInspectorApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PackageInspectorApp />
  </React.StrictMode>,
);
