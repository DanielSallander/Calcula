//! FILENAME: app/src/main.tsx
// PURPOSE: Application entry point
// CONTEXT: Initializes React and loads the shell application
// ARCHITECTURE: Loads core extensions and feature extensions before rendering

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./shell";
import { loadAddIns } from "./addins";
import { loadExtensions } from "../extensions";
import "./index.css";

// Load core functionality (grid/sheet context menus)
loadAddIns();

// Load feature extensions (pivot, etc.)
loadExtensions();

// Render the application
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
