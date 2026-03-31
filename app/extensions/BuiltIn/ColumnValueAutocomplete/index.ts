//! FILENAME: app/extensions/BuiltIn/ColumnValueAutocomplete/index.ts
// PURPOSE: Extension entry point for Column Value Autocomplete (Excel-style).
// CONTEXT: When typing in a cell (non-formula), suggests matching values from
// the same column. Similar to Excel's AutoComplete feature.

import type { ExtensionModule } from "../../../src/api/contract";
import { OverlayExtensions } from "../../../src/api/ui";
import { onAppEvent, AppEvents } from "../../../src/api/events";
import { AutocompleteEvents } from "../../../src/api/formulaAutocomplete";
import type { AutocompleteInputPayload } from "../../../src/api/formulaAutocomplete";
import {
  setColumnAutocompleteVisible,
  ColumnAutocompleteEvents,
} from "../../../src/api/columnAutocomplete";
import type { AutocompleteKeyPayload } from "../../../src/api/formulaAutocomplete";
import { ColumnAutocompleteOverlay } from "./ColumnAutocompleteOverlay";
import {
  useColumnAutocompleteStore,
  invalidateColumnValueCache,
} from "./useColumnAutocompleteStore";

const OVERLAY_ID = "column-value-autocomplete";

let cleanups: Array<() => void> = [];

function activate(): void {
  console.log("[ColumnValueAutocomplete] activate() called");

  // 1. Register and immediately show the overlay.
  //    The component returns null when there is nothing to display.
  OverlayExtensions.registerOverlay({
    id: OVERLAY_ID,
    component: ColumnAutocompleteOverlay,
    layer: "dropdown",
  });
  OverlayExtensions.showOverlay(OVERLAY_ID);

  // 2. Listen for input events from editors (shared with formula autocomplete).
  //    Column autocomplete only activates for non-formula values.
  cleanups.push(
    onAppEvent<AutocompleteInputPayload>(
      AutocompleteEvents.INPUT,
      (payload) => {
        const row = payload.row ?? -1;
        const col = payload.col ?? -1;
        if (row >= 0 && col >= 0) {
          useColumnAutocompleteStore.getState().handleInput(payload, row, col);
        }
      }
    )
  );

  // 3. Listen for keyboard events forwarded from editors
  cleanups.push(
    onAppEvent<AutocompleteKeyPayload>(
      ColumnAutocompleteEvents.KEY,
      (payload) => {
        useColumnAutocompleteStore.getState().handleKey(payload.key);
      }
    )
  );

  // 4. Listen for dismiss events (e.g., from editor unmount or blur)
  cleanups.push(
    onAppEvent(AutocompleteEvents.DISMISS, () => {
      useColumnAutocompleteStore.getState().reset();
    })
  );

  // 5. Invalidate column value cache when cells change
  cleanups.push(
    onAppEvent(AppEvents.CELLS_UPDATED, () => {
      invalidateColumnValueCache();
    })
  );
}

function deactivate(): void {
  OverlayExtensions.hideOverlay(OVERLAY_ID);
  OverlayExtensions.unregisterOverlay(OVERLAY_ID);

  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];

  useColumnAutocompleteStore.getState().reset();
  setColumnAutocompleteVisible(false);
  invalidateColumnValueCache();
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.column-value-autocomplete",
    name: "Column Value Autocomplete",
    version: "1.0.0",
    description:
      "Excel-style autocomplete suggesting matching values from the same column",
  },
  activate,
  deactivate,
};

export default extension;
