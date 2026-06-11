//! FILENAME: app/e2e/walker/sources.ts
// PURPOSE: Action sources for the walk runner. Two implementations:
//          - GeneratorSource: seeded PRNG with context-aware weighting; picks
//            both the action AND its parameters deterministically.
//          - TraceSource: replays an explicit recorded trace (the unit of
//            replay/minimization — preconditions are re-checked, actions
//            whose preconditions no longer hold are skipped).

import type { StateSnapshot } from "../invariants/stateSnapshot";
import type { ActionInstance, ActionTrace } from "./trace";
import type { AnyActionDef } from "./actionCatalog";
import { ACTION_CATALOG, FULL_ACTION_CATALOG, findAction } from "./actionCatalog";

// ============================================================================
// Types
// ============================================================================

export interface ActionSource {
  /** Seed for logging (null for trace replay). */
  seed: number | null;
  /** Pick the next action, or null when exhausted (trace replay only). */
  next(snapshot: StateSnapshot, step: number): ActionInstance | null;
}

// ============================================================================
// Seeded PRNG (mulberry32 — same as v1 generator)
// ============================================================================

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Generator source
// ============================================================================

export interface GeneratorSourceOptions {
  seed: number;
  catalog?: AnyActionDef[];
  /** Probability of queueing a create -> immediate delete pair. Default 0.15 */
  rapidFireProbability?: number;
}

export function createGeneratorSource(options: GeneratorSourceOptions): ActionSource {
  const seed = options.seed;
  const rng = mulberry32(seed);
  const catalog = options.catalog ?? ACTION_CATALOG;
  const rapidFireProb = options.rapidFireProbability ?? 0.15;

  let pendingRapidFireDelete: AnyActionDef | null = null;

  function pickWeighted(snapshot: StateSnapshot): AnyActionDef {
    const eligible = catalog.filter((a) => a.precondition(snapshot));
    if (eligible.length === 0) {
      return catalog.find((a) => a.id === "cell.click")!;
    }

    // Context-aware weight adjustments (same heuristics as v1)
    const weights = eligible.map((a) => {
      let w = a.weight;
      const totalObjects =
        snapshot.logical.slicers.length +
        snapshot.logical.charts.length +
        snapshot.logical.tables.length +
        snapshot.logical.timelines.length +
        snapshot.logical.sparklineGroups.length;

      if (a.id.endsWith(".create") && totalObjects < 2) w *= 2;
      if (a.id.endsWith(".delete") && totalObjects > 3) w *= 2;
      if (a.id.endsWith(".select-into") || a.id === "chart.select") {
        const hasContextualTab = snapshot.visual.ribbonTabs.some(
          (t) => t.accentColor !== null
        );
        if (!hasContextualTab) w *= 1.5;
      }
      return w;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let roll = rng() * totalWeight;
    let selected = eligible[0];
    for (let i = 0; i < eligible.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        selected = eligible[i];
        break;
      }
    }
    return selected;
  }

  function next(snapshot: StateSnapshot, step: number): ActionInstance {
    let def: AnyActionDef;

    if (pendingRapidFireDelete && pendingRapidFireDelete.precondition(snapshot)) {
      def = pendingRapidFireDelete;
      pendingRapidFireDelete = null;
    } else {
      pendingRapidFireDelete = null;
      def = pickWeighted(snapshot);

      // Rapid-fire: after a create, sometimes queue the matching delete.
      if (def.id.endsWith(".create") && rng() < rapidFireProb) {
        const deleteAction = catalog.find(
          (a) => a.category === def.category && a.id.endsWith(".delete")
        );
        if (deleteAction) pendingRapidFireDelete = deleteAction;
      }
    }

    const params = def.pickParams(rng, snapshot, step);
    return { id: def.id, params };
  }

  return { seed, next };
}

// ============================================================================
// Trace source (explicit replay)
// ============================================================================

export interface TraceReplayLog {
  /** Indices of trace actions skipped because their precondition failed. */
  skipped: number[];
}

export function createTraceSource(
  trace: ActionTrace,
  catalog: AnyActionDef[] = FULL_ACTION_CATALOG,
  log?: TraceReplayLog
): ActionSource {
  let index = 0;

  function next(snapshot: StateSnapshot, _step: number): ActionInstance | null {
    while (index < trace.actions.length) {
      const instance = trace.actions[index];
      const def = findAction(instance.id, catalog);
      index++;
      if (!def) {
        log?.skipped.push(index - 1);
        continue;
      }
      if (!def.precondition(snapshot)) {
        log?.skipped.push(index - 1);
        continue;
      }
      return instance;
    }
    return null;
  }

  return { seed: trace.seed, next };
}
