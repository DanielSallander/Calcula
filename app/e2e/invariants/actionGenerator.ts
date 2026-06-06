//! FILENAME: app/e2e/invariants/actionGenerator.ts
// PURPOSE: Seeded pseudo-random action generator with context-aware weighting.
//          Uses mulberry32 PRNG for deterministic, reproducible sequences.

import type { Action } from "./actions";
import { ACTION_CATALOG } from "./actions";
import type { StateSnapshot } from "./stateSnapshot";

// ============================================================================
// Seeded PRNG (mulberry32)
// ============================================================================

/**
 * Mulberry32 — a fast 32-bit seeded PRNG. Returns values in [0, 1).
 * Deterministic: same seed always produces the same sequence.
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Action Generator
// ============================================================================

export interface GeneratorOptions {
  /** Seed for deterministic replay. Use Date.now() for random exploration. */
  seed: number;
  /** Custom action catalog (defaults to ACTION_CATALOG) */
  actions?: Action[];
  /**
   * Probability of generating a "rapid-fire" pair (create then immediately
   * delete) — the exact pattern that triggers state consistency bugs.
   * Default: 0.15 (15%)
   */
  rapidFireProbability?: number;
}

export interface ActionGenerator {
  /** The seed used (for logging on failure) */
  seed: number;
  /** Pick the next action given the current state */
  next: (snapshot: StateSnapshot) => Action;
}

export function createActionGenerator(options: GeneratorOptions): ActionGenerator {
  const seed = options.seed;
  const random = mulberry32(seed);
  const catalog = options.actions ?? ACTION_CATALOG;
  const rapidFireProb = options.rapidFireProbability ?? 0.15;

  // Track if we're in a rapid-fire sequence
  let pendingRapidFireDelete: Action | null = null;

  function next(snapshot: StateSnapshot): Action {
    // If we have a pending rapid-fire delete, execute it now
    if (pendingRapidFireDelete) {
      const action = pendingRapidFireDelete;
      pendingRapidFireDelete = null;
      // Only if precondition still holds (the create may have failed)
      if (action.precondition(snapshot)) {
        return action;
      }
      // Fall through to normal selection
    }

    // Filter to actions whose preconditions are met
    const eligible = catalog.filter((a) => a.precondition(snapshot));
    if (eligible.length === 0) {
      // Fallback: always-valid action
      return catalog.find((a) => a.id === "cell.click")!;
    }

    // Apply context-aware weight adjustments
    const weights = eligible.map((a) => {
      let w = a.weight;

      // Boost creation when few objects exist
      if (a.id.endsWith(".create")) {
        const totalObjects =
          snapshot.logical.slicers.length +
          snapshot.logical.charts.length +
          snapshot.logical.tables.length +
          snapshot.logical.timelines.length +
          snapshot.logical.sparklineGroups.length;
        if (totalObjects < 2) w *= 2;
      }

      // Boost deletion when many objects exist
      if (a.id.endsWith(".delete")) {
        const totalObjects =
          snapshot.logical.slicers.length +
          snapshot.logical.charts.length +
          snapshot.logical.tables.length +
          snapshot.logical.timelines.length +
          snapshot.logical.sparklineGroups.length;
        if (totalObjects > 3) w *= 2;
      }

      // Boost select-into actions when objects exist but no contextual tab shown
      if (a.id.endsWith(".select-into") || a.id === "chart.select") {
        const hasContextualTab = snapshot.visual.ribbonTabs.some(
          (t) => t.accentColor !== null
        );
        if (!hasContextualTab) w *= 1.5;
      }

      return w;
    });

    // Weighted random selection
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let roll = random() * totalWeight;
    let selected = eligible[0];
    for (let i = 0; i < eligible.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        selected = eligible[i];
        break;
      }
    }

    // Rapid-fire: if we just selected a create, sometimes queue the matching delete
    if (selected.id.endsWith(".create") && random() < rapidFireProb) {
      const category = selected.category;
      const deleteAction = catalog.find(
        (a) => a.category === category && a.id.endsWith(".delete")
      );
      if (deleteAction) {
        pendingRapidFireDelete = deleteAction;
      }
    }

    return selected;
  }

  return { seed, next };
}
