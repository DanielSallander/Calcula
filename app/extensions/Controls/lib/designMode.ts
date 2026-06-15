//! FILENAME: app/extensions/Controls/lib/designMode.ts
// PURPOSE: Re-export of the design-mode flag, which now lives in @api so any
//          extension's object overlays can gate on it (facade compliance). Kept
//          as a thin re-export so Controls' existing imports keep working and the
//          singleton stays a single shared instance.

// Import the specific submodule (not the "@api" barrel) so consumers of
// design mode don't transitively pull in the whole API surface.
export {
  getDesignMode,
  setDesignMode,
  toggleDesignMode,
  onDesignModeChange,
  DESIGN_MODE_CHANGED_EVENT,
} from "@api/designMode";
