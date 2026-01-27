//! FILENAME: app/src/main.tsx
// PURPOSE: Application entry point
// CONTEXT: Initializes React and loads the shell application

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./shell";
import { loadAddIns } from "./addins";
import "./index.css";

// Load registered add-ins
loadAddIns();

// Render the application
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
