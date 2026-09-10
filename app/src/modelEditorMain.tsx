//! FILENAME: app/src/modelEditorMain.tsx
// PURPOSE: React entry point for the Model Editor window (VBA-style
//          standalone editor). Does NOT load Shell or GridProvider — just the
//          model editor app.

import React from "react";
import ReactDOM from "react-dom/client";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { initSkinLoader } from "./core/theme/skinLoader";
import { getBootPreferredSkinId } from "./api/appearancePolicy";
import { ModelEditorApp } from "../extensions/ModelEditor/components/ModelEditorApp";
import { installModelEditorStyles } from "../extensions/ModelEditor/components/theme";

// Stamp the active skin's CSS variables BEFORE first paint, exactly as
// main.tsx:34 does. Without this the model-editor window was skin-BLIND: it is
// a separate Tauri window with its own React tree, nothing ever injected the
// ~130 theme variables onto its :root, and switching Calcula to Dark left this
// window white. Every `var(--token, literal)` in here silently took its light
// fallback.
//
// initSkinLoader is idempotent and self-contained (registry + localStorage +
// one <style> element), and localStorage is shared across the app's windows,
// so this picks up the same skin the main window is showing.
//
// Use THIS function, not getMergedTokens/getSkinTokens — that is the swatch
// PREVIEW path used by the Appearance settings page, and it drops forcedBase,
// highContrast, minFontScale and reduced-motion. Copying it here would ship a
// second, drifting skin applier.
initSkinLoader(getBootPreferredSkinId());

// Hover, :focus-visible, ::placeholder and scrollbars cannot be expressed as
// inline styles, and this window is styled almost entirely with inline styles
// — which is exactly why it had no hover feedback and no focus ring anywhere.
installModelEditorStyles();

// This window is created with dragDropEnabled: false so HTML5 drag-and-drop
// works (Tauri's native handler swallows it on Windows) — which also hands OS
// file drops to the DOM, where Chromium's DEFAULT action is to NAVIGATE the
// page to the dropped file, unmounting the editor. Cancel that default
// window-wide; the sanctioned drop zones (measure folders, the Monaco editor)
// handle their own drops independently of this.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// A render-time exception with no boundary above it unmounts the tree and
// leaves this window blank -- and a standalone Tauri window has no devtools
// and no address bar, so blank is indistinguishable from hung. BUG-0083.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary surface="Model Editor">
    <React.StrictMode>
      <ModelEditorApp />
    </React.StrictMode>
  </RootErrorBoundary>,
);
