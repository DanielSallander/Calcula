//! FILENAME: app/extensions/Controls/lib/controlDelete.ts
// PURPOSE: The ORDER of a floating control's delete: the backend removal
//          FIRST, and only once it has landed, everything that hangs off the
//          control -- its object scripts, its declared properties, its custom
//          renderer and HTML overlay, its store entry.
// CONTEXT: Wave-B B6. `deleteFloatingControl` deleted the object script and
//          cleared the side tables BEFORE it asked the backend to remove the
//          control. The backend can refuse (a sheet whose protection does not
//          allow editing objects, `remove_control_metadata`), and a refused
//          delete then left the control standing with its SCRIPT GONE -- a
//          button that no longer did anything, and no undo for the script. The
//          steps are the caller's (they close over the extension's stores); the
//          order is this module's, so it is decided once and tested by running it.

/** What deleting one floating control does, as separately callable steps. */
export interface FloatingControlDeleteSteps {
  /**
   * The backend removal (`remove_control_metadata`). Resolves when it has
   * landed -- including "there was nothing to remove" -- and REJECTS when the
   * backend refuses.
   */
  removeMetadata(): Promise<unknown>;
  /** Delete the control's object scripts (a missing script is not an error). */
  deleteScripts(): Promise<void>;
  /** Clear the instance-keyed side tables (declared properties, renderers, overlays). */
  clearSideTables(): void;
  /** Drop the store entry, the selection, the Properties pane and the caches; repaint. */
  finish(): void | Promise<void>;
}

/**
 * Run a floating control's delete in the one safe order. A refusal rejects
 * with the backend's reason BEFORE anything else is touched, so the control
 * the backend kept still has its scripts, properties and renderers.
 */
export async function runFloatingControlDelete(steps: FloatingControlDeleteSteps): Promise<void> {
  await steps.removeMetadata();
  try {
    await steps.deleteScripts();
  } catch {
    // Ignore errors -- the control may have had no script.
  }
  steps.clearSideTables();
  await steps.finish();
}
