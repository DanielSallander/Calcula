//! FILENAME: app/src/main.tsx
// PURPOSE: Application entry point
// CONTEXT: Initializes React and loads the shell application
// ARCHITECTURE: Loads core extensions and feature extensions before rendering

import { installLogFilter } from "./utils/logFilter";
installLogFilter();

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./shell";
import { exposeExtensionRuntimeGlobals } from "./api/extensionRuntime";
import { initObjectScriptBadges } from "./api/objectScriptBadge";
import { initSkinLoader } from "./core/theme/skinLoader";
import { getBootPreferredSkinId, applyAppearancePolicyAfterPaint } from "./api/appearancePolicy";
import "./index.css";

// C2: publish the host's React singleton BEFORE any extension loads, so
// runtime-loaded third-party extensions render UI with the host's React (a
// second bundled React would break hooks/context). @api is NOT globalized —
// extensions receive it via the per-extension ExtensionContext (scoped).
exposeExtensionRuntimeGlobals();

// T4: wire the shared object script-presence cache so grid-object overlays
// (slicers, charts, ...) can show a "has script" badge in design mode.
initObjectScriptBadges();

// Appearance: inject the active App Skin's CSS variables BEFORE first paint so a
// persisted (or, for unmanaged installs, the built-in) skin shows with no flash.
// The user's persisted choice (localStorage) is read synchronously here; the
// enterprise managed-default policy is resolved asynchronously just after paint
// (it requires a Tauri round-trip) and only swaps if the user hasn't chosen.
initSkinLoader(getBootPreferredSkinId());
void applyAppearancePolicyAfterPaint();

// NOTE: Feature extensions (pivot, etc.) are loaded in useExtensionInitializer
// AFTER bootstrapShell() so that services (DialogExtensions, etc.) are available.

// DEV/E2E ONLY: expose a dynamic-import helper so e2e tests (which run inside
// page.evaluate as classic scripts and can't use `import` directly) can pull in
// app modules WITHOUT `new Function` — which would require 'unsafe-eval' in the
// CSP. `import()` is not eval and is allowed under a no-unsafe-eval policy.
// Stripped from production builds by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV) {
  (window as unknown as { __calcImport?: (u: string) => Promise<unknown> }).__calcImport =
    (u: string) => import(/* @vite-ignore */ u);
}

// Render the application
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
