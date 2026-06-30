//! FILENAME: app/extensions/Animation/lib/driver.ts
// PURPOSE: The generic Driver contract advanced by the playback clock.
// CONTEXT: An animation is "a generic Driver advanced by a clock". The clock
//          knows nothing about cells / charts / scenarios / RAND; each driver
//          implements this tiny interface. A driver must be able to (1) capture
//          the model state it will mutate so it can be restored, (2) apply one
//          frame transiently, and (3) restore the captured state.

export interface Driver {
  /** Total integer frames this driver produces. The clock clamps the play range to [0, frameCount-1]. */
  readonly frameCount: number;

  /**
   * Capture the model state this driver will mutate, so it can be restored.
   * Called once before the first applyFrame (on play / seek / step from idle).
   */
  snapshot(): Promise<void>;

  /**
   * Apply frame `t` transiently: write the driver value(s), recalc, repaint.
   * Idempotent w.r.t. the snapshot — each call overwrites the previous frame's
   * transient state, never accumulating.
   */
  applyFrame(t: number): Promise<void>;

  /**
   * Restore the model to the captured snapshot and repaint. Safe to call even if
   * snapshot() never ran (no-op).
   */
  restore(): Promise<void>;

  /** Optional human label for the current frame value, shown on the scrubber. */
  frameLabel?(t: number): string;
}
