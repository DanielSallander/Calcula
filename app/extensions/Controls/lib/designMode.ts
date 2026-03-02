//! FILENAME: app/extensions/Controls/lib/designMode.ts
// PURPOSE: Design Mode state management for the Controls extension.
// CONTEXT: Frontend-only session state. When ON, clicking controls selects them
//          for editing. When OFF, clicking controls triggers their actions.

// ============================================================================
// State
// ============================================================================

let designMode = false;

/** Custom event name for design mode changes. */
export const DESIGN_MODE_CHANGED_EVENT = "controls:design-mode-changed";

// ============================================================================
// API
// ============================================================================

/** Get the current design mode state. */
export function getDesignMode(): boolean {
  return designMode;
}

/** Set the design mode state. Emits a change event. */
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
