//! FILENAME: app/extensions/Controls/lib/geometryWriteOrder.ts
// PURPOSE: The ORDER between a floating control's geometry WRITES and the
//          renderers' property READS (BUG-0268).
// CONTEXT: Each floating renderer (Button/floatingRenderer.ts,
//          Shape/shapeRenderer.ts, Image/imageRenderer.ts) re-reads a control's
//          resolved properties after an invalidation and writes the resolved
//          width/height BACK into the store (`applyResolvedControlSize` in
//          floatingStore.ts) -- the write-back exists for a formula-driven
//          size. A Core-handle resize invalidates those caches and asks for a
//          paint in the same tick in which it STARTS persisting the new
//          geometry (`set_control_geometry`), and Tauri dispatches commands on
//          a thread pool, so nothing ordered the paint's read after the write.
//          Served first, the read returned the OLD width and the write-back
//          put the store -- and so the published GridRegion that Core's chrome,
//          the canvas padlock and every hit test read -- back to the old
//          rectangle, while the backend held the new one. The cache was fresh
//          after that, so nothing read it again. Found live 2026-09-30 (e2e run
//          9c, moving-objects step 9: a canvas shape resized 160 -> 224 read
//          224 in `get_all_controls` and 160 in `getGridRegions()`).
//
//          THE RULE. A size read is CURRENT only when nothing about the
//          control's geometry changed while it was on its way: no size change
//          in the frontend store, no geometry write started or landed, and no
//          write still in flight when it is delivered. A read that is not
//          current is not applied: the renderer marks its entry stale and reads
//          again at the next paint. And a read is never STARTED under a write
//          in flight -- it waits for the write first -- so that re-read is
//          served after the write and converges instead of spinning.
//
//          Keyed by the control's ANCHOR (sheet, row, col), which the renderer
//          (the region's data), the store (the control) and the IPC wrapper (the
//          batch) all carry. A LEAF: it imports nothing.

/** A control's anchor: the cell its id and its backend record are keyed by. */
export interface ControlAnchor {
  sheetIndex: number;
  row: number;
  col: number;
}

const keyOf = (a: ControlAnchor): string => `${a.sheetIndex}:${a.row}:${a.col}`;

/** Bumped whenever the control's geometry changed in a way a read in flight did not see. */
const epochs = new Map<string, number>();

/** The geometry writes of a control that have not landed yet: how many, and when all have. */
const inFlight = new Map<string, { count: number; landed: Promise<void> }>();

function bump(key: string): void {
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
}

/**
 * The frontend changed a control's SIZE (a resize preview or commit, a group
 * scale, an arrange). A read already on its way describes the old size.
 */
export function noteControlGeometryChanged(anchor: ControlAnchor): void {
  bump(keyOf(anchor));
}

/**
 * A geometry write for these controls is on its way to the backend. Returns
 * the same promise. Call it synchronously when the write is ISSUED (the IPC
 * wrapper `setControlGeometry` does), so a read the same tick starts is
 * already ordered behind it.
 */
export function trackControlGeometryWrite<T>(anchors: readonly ControlAnchor[], write: Promise<T>): Promise<T> {
  const landed: Promise<void> = write.then(
    () => undefined,
    () => undefined,
  );
  const keys = [...new Set(anchors.map(keyOf))];
  for (const key of keys) {
    bump(key);
    const prev = inFlight.get(key);
    inFlight.set(key, {
      count: (prev?.count ?? 0) + 1,
      landed: prev ? prev.landed.then(() => landed) : landed,
    });
  }
  void landed.then(() => {
    for (const key of keys) {
      bump(key);
      const entry = inFlight.get(key);
      if (!entry) continue;
      if (entry.count <= 1) inFlight.delete(key);
      else entry.count -= 1;
    }
  });
  return write;
}

/**
 * Settles when every geometry write for the control issued so far has landed
 * (or failed); null when none is in flight -- a read then starts at once.
 */
export function controlGeometryWritesInFlight(anchor: ControlAnchor): Promise<void> | null {
  return inFlight.get(keyOf(anchor))?.landed ?? null;
}

/**
 * Start a size read of a control. The returned check answers, when the read is
 * delivered, whether it is still CURRENT: nothing changed the control's
 * geometry since it started, and no geometry write is still in flight.
 */
export function beginControlGeometryRead(anchor: ControlAnchor): () => boolean {
  const key = keyOf(anchor);
  const at = epochs.get(key) ?? 0;
  return () => (epochs.get(key) ?? 0) === at && !inFlight.has(key);
}

/** Tests: forget every epoch and every write in flight. */
export function resetControlGeometryWriteOrder(): void {
  epochs.clear();
  inFlight.clear();
}
