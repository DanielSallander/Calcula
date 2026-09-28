//! FILENAME: app/extensions/FloatingRange/lib/frEditingRange.ts
// PURPOSE: Which floating range has its cell editor open -- the one fact the
//          region store needs from the editor, without importing the editor.
// CONTEXT: The store publishes `resizable`, which Core reads for the corner
//          boxes it paints and hit-tests; the owner ruled that a range's
//          resize handles stand down while one of its cells is being edited
//          (2026-09-27). The editor (editor/frEditor.ts) writes this on open
//          and on teardown, and the store re-publishes on the signal.
//
//          A module of its own because the editor already imports the store:
//          the store importing the editor back would be an import cycle, and
//          every test that mocks the editor would take the store down with it.

let editingFrId: string | null = null;
const listeners = new Set<() => void>();

/** The editor opened on range `frId` (or closed: null). Notifies on a change only. */
export function setFrEditingRange(frId: string | null): void {
  if (editingFrId === frId) return;
  editingFrId = frId;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[FloatingRange] editing-range listener threw:", err);
    }
  }
}

/** The id of the range whose cell editor is open, or null. */
export function getFrEditingRange(): string | null {
  return editingFrId;
}

/** Hear the editor open or close (by range). Returns the unsubscribe. */
export function onFrEditingRangeChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
