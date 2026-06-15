//! FILENAME: app/src/api/designMode.ts
// PURPOSE: Design Mode — a frontend-only, app-global session flag. When ON,
//          clicking a scriptable object selects it for editing (and overlays may
//          show affordances like script badges); when OFF, clicking triggers the
//          object's action.
// CONTEXT: Promoted to @api (from the Controls extension) so ANY object overlay
//          — slicers, charts, etc., which live in their own extensions — can gate
//          on it without importing another extension (facade compliance). A
//          single module-level singleton: all surfaces share one instance.

let designMode = false;

/** Custom event name for design mode changes. */
export const DESIGN_MODE_CHANGED_EVENT = "controls:design-mode-changed";

/** Get the current design mode state. */
export function getDesignMode(): boolean {
  return designMode;
}

/** Set the design mode state. Emits a change event when it changes. */
export function setDesignMode(value: boolean): void {
  if (designMode === value) return;
  designMode = value;
  window.dispatchEvent(
    new CustomEvent(DESIGN_MODE_CHANGED_EVENT, { detail: { designMode: value } }),
  );
}

/** Toggle the design mode state. Emits a change event. */
export function toggleDesignMode(): void {
  setDesignMode(!designMode);
}

/** Subscribe to design mode changes. Returns a cleanup function. */
export function onDesignModeChange(
  callback: (designMode: boolean) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ designMode: boolean }>).detail;
    callback(detail.designMode);
  };
  window.addEventListener(DESIGN_MODE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(DESIGN_MODE_CHANGED_EVENT, handler);
}
