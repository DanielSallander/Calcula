//! FILENAME: app/src/modelEditorMain.tsx
// PURPOSE: React entry point for the Model Editor window (VBA-style
//          standalone editor). Does NOT load Shell or GridProvider — just the
//          model editor app.

import React from "react";
import ReactDOM from "react-dom/client";
import { ModelEditorApp } from "../extensions/ModelEditor/components/ModelEditorApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ModelEditorApp />
  </React.StrictMode>,
);
