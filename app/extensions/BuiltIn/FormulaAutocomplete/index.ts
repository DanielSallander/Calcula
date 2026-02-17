//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/index.ts
// PURPOSE: Extension entry point for Formula Autocomplete (Intellisense).
// CONTEXT: Registers the overlay, loads the function catalog, and wires up
// event listeners that bridge editor input to the autocomplete store.
// NOTE: The overlay is shown immediately on activation. The component itself
// returns null when there is nothing to render (dropdown/hints hidden).
// This avoids depending on app:edit-started/ended events which are not
// reliably emitted by all editing paths.

import type { ExtensionModule } from "../../../src/api/contract";
import { OverlayExtensions } from "../../../src/api/ui";
import { onAppEvent } from "../../../src/api/events";
import {
  setFormulaAutocompleteVisible,
  AutocompleteEvents,
} from "../../../src/api/formulaAutocomplete";
import type {
  AutocompleteInputPayload,
  AutocompleteKeyPayload,
} from "../../../src/api/formulaAutocomplete";
import { FormulaAutocompleteOverlay } from "./FormulaAutocompleteOverlay";
import { useAutocompleteStore } from "./useAutocompleteStore";

const OVERLAY_ID = "formula-autocomplete";

// Cleanup functions for event listeners
let cleanups: Array<() => void> = [];

function activate(): void {
  console.log("[FormulaAutocomplete] activate() called");

  // 1. Register and immediately show the overlay component.
  //    The component returns null when there is nothing to display,
  //    so being "always shown" has no visual cost.
  OverlayExtensions.registerOverlay({
    id: OVERLAY_ID,
    component: FormulaAutocompleteOverlay,
    layer: "dropdown",
  });
  OverlayExtensions.showOverlay(OVERLAY_ID);
  console.log("[FormulaAutocomplete] Overlay registered and shown");

  // 2. Load function catalog from the Rust backend
  useAutocompleteStore.getState().loadFunctions().then(() => {
    console.log("[FormulaAutocomplete] Function catalog loaded, count:",
      useAutocompleteStore.getState().items.length || "check functionCatalog");
  });

  // 3. Listen for input events from editors
  cleanups.push(
    onAppEvent<AutocompleteInputPayload>(
      AutocompleteEvents.INPUT,
      (payload) => {
        useAutocompleteStore.getState().handleInput(payload);
      }
    )
  );

  // 4. Listen for keyboard events forwarded from editors
  cleanups.push(
    onAppEvent<AutocompleteKeyPayload>(AutocompleteEvents.KEY, (payload) => {
      useAutocompleteStore.getState().handleKey(payload.key);
    })
  );

  // 5. Listen for dismiss events (e.g., from editor unmount or blur)
  cleanups.push(
    onAppEvent(AutocompleteEvents.DISMISS, () => {
      useAutocompleteStore.getState().reset();
    })
  );
}

function deactivate(): void {
  // Unregister and hide overlay
  OverlayExtensions.hideOverlay(OVERLAY_ID);
  OverlayExtensions.unregisterOverlay(OVERLAY_ID);

  // Clean up all event listeners
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];

  // Reset state
  useAutocompleteStore.getState().reset();
  setFormulaAutocompleteVisible(false);
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.formula-autocomplete",
    name: "Formula Autocomplete",
    version: "1.0.0",
    description: "Intellisense-style autocomplete for formula functions",
  },
  activate,
  deactivate,
};

export default extension;
