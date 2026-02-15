//! FILENAME: app/src/main.tsx
// PURPOSE: Application entry point
// CONTEXT: Initializes React and loads the shell application
// ARCHITECTURE: Loads core extensions and feature extensions before rendering

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./shell";
import "./index.css";

// NOTE: Feature extensions (pivot, etc.) are loaded in useExtensionInitializer
// AFTER bootstrapShell() so that services (DialogExtensions, etc.) are available.

// Render the application
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
