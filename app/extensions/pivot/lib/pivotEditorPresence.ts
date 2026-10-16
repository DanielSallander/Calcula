//! FILENAME: app/extensions/Pivot/lib/pivotEditorPresence.ts
// PURPOSE: Which pivots have a MOUNTED field-list editor (PivotEditor) right
//          now -- in the worksheet `pivot-editor` pane or in a canvas box's
//          object pane (CanvasPivotBuildBody).
// CONTEXT: A layout change from the Design sections (Grand Totals, Report
//          Layout, ...) is SENT by the editor: it owns the whole fields request
//          and would send its own copy of the layout back on its next edit. So
//          while an editor of the pivot is mounted, a layout change goes to it
//          (PIVOT_LAYOUT_CHANGED, as always); with none mounted -- a canvas
//          box's Format tab opened straight from Ctrl+1, its Layout card -- the
//          change is sent headlessly (pivotLayoutEdits.ts). One sender either
//          way, never two.

const mounted = new Map<string, number>();

/** A PivotEditor of `pivotId` mounted; returns the unmount. */
export function notePivotEditorMounted(pivotId: string): () => void {
  mounted.set(pivotId, (mounted.get(pivotId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (mounted.get(pivotId) ?? 0) - 1;
    if (n > 0) mounted.set(pivotId, n);
    else mounted.delete(pivotId);
  };
}

/** Whether some PivotEditor of `pivotId` is mounted. */
export function hasMountedPivotEditor(pivotId: string): boolean {
  return (mounted.get(pivotId) ?? 0) > 0;
}

/** Tests. */
export function resetPivotEditorPresence(): void {
  mounted.clear();
}
