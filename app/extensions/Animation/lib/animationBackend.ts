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
export async function animSnapshot(
  token: string,
  sheetIndex: number,
  cells: [number, number][],
): Promise<AnimSnapshotResult> {
  const res = await animationBackend.invoke<AnimSnapshotResult>("anim_snapshot", {
    params: { token, sheetIndex, cells },
  });
  if (res?.success) noteBufferFiled(token, sheetIndex);
  return res;
}

// ============================================================================
// Restore buffers this webview filed, so none outlives the page that owns it
// ============================================================================
//
// While an animation's restore buffer is on file in the backend, every what-if
// command (Goal Seek, Data Table, Solver, a scenario) is refused until Stop puts
// the cells back. A buffer whose page is GONE -- the webview reloaded, so the
// clock that would press Stop no longer exists -- used to block them for the
// rest of the session with a message ("Stop the animation") nothing could act
// on. Every buffer this webview files is therefore noted in sessionStorage
// (which survives a reload of the same window) until its restore returns, and
// the extension restores whatever a previous page left on activation
// (`releaseOrphanedBuffers`).

const LEDGER_KEY = "calcula.animation.restoreBuffers";
const ledger = new Map<string, number>();

function persistLedger(): void {
  try {
    if (ledger.size === 0) sessionStorage.removeItem(LEDGER_KEY);
    else sessionStorage.setItem(LEDGER_KEY, JSON.stringify(Array.from(ledger.entries())));
  } catch {
    /* storage unavailable: the in-memory ledger still covers this page */
  }
}

function noteBufferFiled(token: string, sheetIndex: number): void {
  ledger.set(token, sheetIndex);
  persistLedger();
}

function noteBufferReleased(token: string): void {
  if (ledger.delete(token)) persistLedger();
}

/** Buffers a PREVIOUS page of this window filed and never restored. */
function inheritedBuffers(): [string, number][] {
  try {
    const raw = sessionStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is [string, number] =>
        Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Restore every restore buffer a previous page of this window filed and never
 * put back (a reload mid-playback), so the cells it borrowed come back and the
 * what-if commands are no longer refused. Called once on activation, before
 * this page has filed any buffer of its own. Never throws.
 */
export async function releaseOrphanedBuffers(): Promise<number> {
  const orphans = inheritedBuffers().filter(([token]) => !ledger.has(token));
  let released = 0;
  for (const [token, sheetIndex] of orphans) {
    try {
      const res = await animRestore(token, sheetIndex);
      if (!res?.error) released++;
    } catch (e) {
      console.error("[Animation] could not restore an orphaned animation buffer", token, e);
    }
    // Whatever the answer, the backend holds it no longer (restored, dropped
    // with its deleted sheet, or never there after File > New/Open).
    noteBufferReleased(token);
  }
  // The stored ledger now lists this page's own buffers only.
  persistLedger();
  return released;
}

/**
 * Apply one frame's transient writes and recalculate dependents. Does NOT touch
 * the undo stack and does NOT mark the document dirty. `token` must be the token
 * passed to {@link animSnapshot}: the backend refuses a frame whose restore buffer
 * is not on file, so the no-dirty exemption is proven rather than assumed. The returned cells should
 * be pushed to the repaint path (emit CELLS_UPDATED) so charts + grid update.
 */
export function animApplyFrame(
  token: string,
  sheetIndex: number,
  writes: TransientCellWrite[],
): Promise<AnimationFrameResult> {
  return animationBackend.invoke<AnimationFrameResult>("anim_apply_frame", {
    params: { token, sheetIndex, writes },
  });
}

/**
 * Restore (and drop) the named snapshot buffer, recalculating dependents. Safe to
 * call with an unknown token (no-op) so stop/cleanup is idempotent.
 */
export async function animRestore(token: string, sheetIndex: number): Promise<AnimationFrameResult> {
  const res = await animationBackend.invoke<AnimationFrameResult>("anim_restore", {
    params: { token, sheetIndex },
  });
  // The backend no longer holds the buffer once a restore has answered:
  // restored, dropped with a deleted sheet, or never on file.
  noteBufferReleased(token);
  return res;
}

/** Result of one Monte Carlo trial (re-roll volatiles + read the outcome cell). */
export interface AnimRerollResult {
  value: number | null;
  error: string | null;
}

/**
 * Force a full sheet recalc (re-rolls RAND/RANDBETWEEN) and read the outcome
 * cell's numeric value. One call == one Monte Carlo trial.
 */
export function animRerollAndRead(
  sheetIndex: number,
  outcomeRow: number,
  outcomeCol: number,
): Promise<AnimRerollResult> {
  return animationBackend.invoke<AnimRerollResult>("anim_reroll_and_read", {
    params: { sheetIndex, outcomeRow, outcomeCol },
  });
}

/** One scenario's changing cell (as stored by the Scenario Manager). */
export interface ScenarioChangingCell {
  row: number;
  col: number;
  value: string;
}

export interface ScenarioData {
  name: string;
  changingCells: ScenarioChangingCell[];
}

/** List the named scenarios on a sheet (from the Scenario Manager). */
export function listScenarios(sheetIndex: number): Promise<ScenarioData[]> {
  return animationBackend
    .invoke<{ scenarios: ScenarioData[] }>("scenario_list", { sheetIndex })
    .then((r) => r.scenarios ?? []);
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
