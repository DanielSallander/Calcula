//! FILENAME: app/extensions/_shared/lib/queryObjectRefresh.ts
// PURPOSE: THE control-change refresh brain for every query-bound object family
//   (grid reports, design-query charts, future visuals). One place owns:
//   - the @api/controlValues subscription (skip transient previews, 150ms
//     debounce, changed-name accumulation across the debounce window),
//   - targeting (only objects whose @param bindings reference a changed name),
//   - pass coalescing (one pass at a time; changes arriving mid-pass merge into
//     exactly one follow-up pass),
//   - per-provider failure isolation.
//   Families register a QueryObjectProvider; the control subscription starts
//   with the first registration and stops with the last. The @param GRAMMAR
//   side of the same standard lives in _shared/dsl/pivotLayout/paramSubstitution.

import { onControlValueChange } from "@api/controlValues";

/** One query-bound object and the control names its query references. */
export interface QueryObjectBinding {
  id: string;
  name: string;
  /** Control / ribbon-filter names the object's @params reference. */
  boundControls: string[];
}

/** One object family's hookup to the shared refresh service. */
export interface QueryObjectProvider {
  /** Family key, e.g. "report" | "chart". One provider per family. */
  kind: string;
  /** Fresh bindings for every object of this family (called per pass). */
  listBindings(): Promise<QueryObjectBinding[]>;
  /**
   * Re-run these objects' queries (a bound control changed; `changedNames` is
   * null for a refresh-all pass). The provider owns its own repaint/flush and
   * per-object error surfacing — it should log, not throw, per object.
   */
  refreshObjects(ids: string[], changedNames: string[] | null): Promise<void>;
}

const providers = new Map<string, QueryObjectProvider>();

let unsubscribeControls: (() => void) | null = null;
let debounceTimer: number | undefined;
let accumulatedNames = new Set<string>();

// Pass coalescing: one pass at a time; mid-pass requests merge into ONE follow-up.
let inFlight = false;
/** undefined = nothing queued; null = queued "all bound"; else queued names. */
let queuedNames: Set<string> | null | undefined;

function matchesAny(boundControls: string[], changedUpper: Set<string>): boolean {
  return boundControls.some((n) => changedUpper.has(n.toUpperCase()));
}

async function runPass(names: Set<string> | null): Promise<void> {
  const changedUpper = names ? new Set([...names].map((n) => n.toUpperCase())) : null;
  for (const provider of providers.values()) {
    try {
      const bindings = await provider.listBindings();
      const affected = bindings.filter(
        (b) =>
          b.boundControls.length > 0 &&
          (changedUpper === null || matchesAny(b.boundControls, changedUpper)),
      );
      if (affected.length === 0) continue;
      await provider.refreshObjects(
        affected.map((b) => b.id),
        names ? [...names] : null,
      );
    } catch (e) {
      console.warn(`[QueryRefresh] provider "${provider.kind}" failed:`, e);
    }
  }
}

/**
 * Refresh the objects bound (via @params) to the given changed control names —
 * or every bound object when no names are given. Concurrent calls coalesce.
 */
export async function refreshBoundQueryObjects(
  changedNames?: Iterable<string>,
): Promise<void> {
  const requested: Set<string> | null = changedNames ? new Set(changedNames) : null;
  if (inFlight) {
    if (queuedNames === undefined) {
      queuedNames = requested;
    } else if (queuedNames === null || requested === null) {
      queuedNames = null;
    } else {
      for (const n of requested) queuedNames.add(n);
    }
    return;
  }
  inFlight = true;
  try {
    let current: Set<string> | null = requested;
    for (;;) {
      await runPass(current);
      if (queuedNames === undefined) break;
      current = queuedNames;
      queuedNames = undefined;
    }
  } finally {
    inFlight = false;
  }
}

function ensureSubscribed(): void {
  if (unsubscribeControls) return;
  unsubscribeControls = onControlValueChange((detail) => {
    if (detail.transient) return;
    accumulatedNames.add(detail.name);
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      const names = accumulatedNames;
      accumulatedNames = new Set();
      void refreshBoundQueryObjects(names);
    }, 150);
  });
}

function teardownIfIdle(): void {
  if (providers.size > 0 || !unsubscribeControls) return;
  unsubscribeControls();
  unsubscribeControls = null;
  if (debounceTimer) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  accumulatedNames = new Set();
  queuedNames = undefined;
}

/**
 * Register an object family with the shared refresh service.
 * @returns Cleanup that unregisters it (the control subscription stops with the
 *   last provider).
 */
export function registerQueryObjectProvider(provider: QueryObjectProvider): () => void {
  providers.set(provider.kind, provider);
  ensureSubscribed();
  return () => {
    if (providers.get(provider.kind) === provider) {
      providers.delete(provider.kind);
    }
    teardownIfIdle();
  };
}
