//! FILENAME: app/extensions/Animation/lib/animationBackend.ts
// PURPOSE: Capability-scoped backend door + typed wrappers for the Animation
//          extension's transient frame commands (anim_snapshot / anim_apply_frame
//          / anim_restore). Bound to ctx.invokeBackend in activate() (A3), so all
//          calls flow through the same gated door as the rest of the host instead
//          of the raw @api/backend passthrough (which is banned in extensions).
import type { CellData } from "@api";
import { createBackendChannel } from "@api/backendCommands";

export const animationBackend = createBackendChannel("Animation");

/** A single literal write applied transiently for one animation frame. */
export interface TransientCellWrite {
  row: number;
  col: number;
  /** Literal value (number / "TRUE" / "FALSE" / text). Never a formula. */
  value: string;
}

/** Result of applying or restoring a frame: the recalculated cells. */
export interface AnimationFrameResult {
  updatedCells: CellData[];
  error: string | null;
}

/** Acknowledgement of a snapshot capture. */
export interface AnimSnapshotResult {
  success: boolean;
  error: string | null;
}

/**
 * Snapshot the given cells under `token` so a later {@link animRestore} can put
 * the model back exactly. One token per driver run.
 */
export function animSnapshot(
  token: string,
  sheetIndex: number,
  cells: [number, number][],
): Promise<AnimSnapshotResult> {
  return animationBackend.invoke<AnimSnapshotResult>("anim_snapshot", {
    params: { token, sheetIndex, cells },
  });
}

/**
 * Apply one frame's transient writes and recalculate dependents. Does NOT touch
 * the undo stack and does NOT mark the document dirty. The returned cells should
 * be pushed to the repaint path (emit CELLS_UPDATED) so charts + grid update.
 */
export function animApplyFrame(
  sheetIndex: number,
  writes: TransientCellWrite[],
): Promise<AnimationFrameResult> {
  return animationBackend.invoke<AnimationFrameResult>("anim_apply_frame", {
    params: { sheetIndex, writes },
  });
}

/**
 * Restore (and drop) the named snapshot buffer, recalculating dependents. Safe to
 * call with an unknown token (no-op) so stop/cleanup is idempotent.
 */
export function animRestore(token: string, sheetIndex: number): Promise<AnimationFrameResult> {
  return animationBackend.invoke<AnimationFrameResult>("anim_restore", {
    params: { token, sheetIndex },
  });
}

/** One GIF frame: flattened RGBA bytes (width*height*4) + delay in centiseconds. */
export interface GifFrame {
  rgba: number[];
  delayCs: number;
}

export interface GifExportRequest {
  path: string;
  width: number;
  height: number;
  frames: GifFrame[];
  repeat: boolean;
}

/**
 * Encode RGBA frames to an animated GIF and write it to `req.path` (Rust-side,
 * via the gif crate). export_gif is hostFilesystem-privileged; the trusted
 * built-in Animation extension passes the gate.
 */
export function exportGif(req: GifExportRequest): Promise<void> {
  return animationBackend.invoke<void>("export_gif", { req });
}
