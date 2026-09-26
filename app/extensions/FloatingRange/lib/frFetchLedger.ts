//! FILENAME: app/extensions/FloatingRange/lib/frFetchLedger.ts
// PURPOSE: The bookkeeping of a lazy, id-keyed, async-fetched cache: which ids
//          are stale, which have a read in flight, and whether an answer that
//          just landed may still be written.
// CONTEXT: M7. Two caches in this extension are refilled lazily by the paint --
//          the cell values (frRenderer) and the content extent (frExtent) -- and
//          both must keep their LAST answer visible while a new read is in
//          flight (no blink, no scroll range collapsing for a frame). That makes
//          the order of landings matter, and a boolean `pending` cannot express
//          it:
//
//          - An answer OLDER than the one on screen must be dropped. IPC reads
//            run on a thread pool and can complete out of order; a read begun
//            before a cell edit that lands after the read begun after it would
//            put the pre-edit value back.
//          - An answer begun BEFORE the latest invalidation may still be shown
//            (it is newer than what is on screen), but it must not clear the
//            stale mark -- otherwise the post-edit value is never read. The old
//            renderer cleared it, which is that bug.
//          - Dropping every superseded answer instead would STARVE under a
//            steady stream of invalidations (Animation playback recalculates
//            every frame): each read would be overtaken before it landed and
//            the cache would never refresh. Showing any answer newer than the
//            current one guarantees progress.
//          - An answer for an id that was forgotten (object deleted, document
//            reset) must not resurrect it.

export class FrFetchLedger {
  private seq = 0;
  /** Reads begun at or before this sequence number were begun before the last reset. */
  private floor = 0;
  /** id -> sequence of the latest read begun (its end clears `pending`). */
  private readonly latest = new Map<string, number>();
  /** id -> sequence of the answer currently shown (or of the forget). */
  private readonly shown = new Map<string, number>();
  /** id -> the sequence counter at the last invalidation. */
  private readonly invalidatedAt = new Map<string, number>();
  private readonly stale = new Set<string>();
  private readonly pending = new Set<string>();

  /** Start a read for `id`; returns its sequence number. */
  begin(id: string): number {
    const n = ++this.seq;
    this.latest.set(id, n);
    this.pending.add(id);
    return n;
  }

  /** Whether the answer of read `n` may be written: it is newer than what is shown. */
  mayApply(id: string, n: number): boolean {
    return n > this.floor && n > (this.shown.get(id) ?? 0);
  }

  /** Record that read `n`'s answer is now shown. Clears `stale` only when the
   *  read began AFTER the last invalidation. */
  applied(id: string, n: number): void {
    this.shown.set(id, n);
    if (n > (this.invalidatedAt.get(id) ?? 0)) this.stale.delete(id);
  }

  /** A read ended (landed, failed or was dropped). Only the latest one clears `pending`. */
  end(id: string, n: number): void {
    if (this.latest.get(id) === n) this.pending.delete(id);
  }

  /** The id's shown answer is out of date: keep it, but read again. Also
   *  releases `pending`, so the next paint starts the re-read at once. */
  invalidate(id: string): void {
    this.stale.add(id);
    this.invalidatedAt.set(id, this.seq);
    this.pending.delete(id);
  }

  /** Invalidate every id that has an answer or a read, plus `extraIds`. */
  invalidateAll(extraIds: Iterable<string> = []): void {
    const ids = new Set<string>([...this.shown.keys(), ...this.latest.keys(), ...extraIds]);
    for (const id of ids) {
      this.stale.add(id);
      this.invalidatedAt.set(id, this.seq);
    }
    this.pending.clear();
  }

  /** Forget one id: any read already begun for it can no longer write. */
  forget(id: string): void {
    this.latest.delete(id);
    this.invalidatedAt.delete(id);
    this.stale.delete(id);
    this.pending.delete(id);
    // Not deleted: a floor for this id, so an in-flight answer stays dropped.
    this.shown.set(id, this.seq);
  }

  /** Forget everything (document change, deactivate). */
  reset(): void {
    this.floor = this.seq;
    this.latest.clear();
    this.shown.clear();
    this.invalidatedAt.clear();
    this.stale.clear();
    this.pending.clear();
  }

  isStale(id: string): boolean {
    return this.stale.has(id);
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }
}
