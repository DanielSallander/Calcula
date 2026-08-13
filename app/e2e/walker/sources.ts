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
  /**
   * Per-family multipliers applied to the catalog's base weights, so a walk
   * can be aimed at a surface without editing the catalog.
   *
   * WHY THIS EXISTS. The catalog's weights are flat by design — every one of
   * the 59 actions gets a comparable share, so a 75-action walk spends about
   * four actions on any given family and a whole surface can go unvisited for
   * a dozen walks running. That is exactly how `chart.create` shipped for the
   * entire programme talking to the backend and never to the chart store
   * (BUG-0031): the walks that would have caught it were statistically thin on
   * charts AND the actions were no-ops when they did fire, so nothing showed.
   * A boost makes "explore THIS surface hard" a run parameter rather than an
   * edit, and the trace stays exactly as replayable because replay reads the
   * recorded action list, not the weights.
   *
   * A key matches an action if it equals the action's `category` OR the part
   * of its id before the first dot — `{chart: 8}` therefore also lifts
   * `chart.deselect`, whose category is the cross-feature "deselect".
   */
  categoryWeights?: Record<string, number>;
}

/**
 * Parse a `"chart:8,table:2"` family-boost spec (the env-var form).
 * Returns null for empty/absent input so callers can pass it straight through.
 */
export function parseCategoryWeights(
  spec: string | undefined | null
): Record<string, number> | undefined {
  if (!spec) return undefined;
  const out: Record<string, number> = {};
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(":");
    if (idx <= 0) {
      throw new Error(
        `Bad category weight "${trimmed}" — expected "<family>:<multiplier>"`
      );
    }
    const key = trimmed.slice(0, idx).trim();
    const value = Number(trimmed.slice(idx + 1).trim());
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Bad multiplier for "${key}" in "${trimmed}" — expected a finite number >= 0`
      );
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The family keys a boost spec may name, for an action. */
export function actionFamilies(def: AnyActionDef): string[] {
  const prefix = def.id.split(".")[0];
  return prefix === def.category ? [def.category] : [def.category, prefix];
}

export function createGeneratorSource(options: GeneratorSourceOptions): ActionSource {
  const seed = options.seed;
  const rng = mulberry32(seed);
  const catalog = options.catalog ?? ACTION_CATALOG;
  const rapidFireProb = options.rapidFireProbability ?? 0.15;
  const categoryWeights = options.categoryWeights ?? {};

  let pendingRapidFireDelete: AnyActionDef | null = null;

  function familyMultiplier(def: AnyActionDef): number {
    let m = 1;
    for (const family of actionFamilies(def)) {
      const v = categoryWeights[family];
      if (v !== undefined) m *= v;
    }
    return m;
  }

  function pickWeighted(snapshot: StateSnapshot): AnyActionDef {
    const eligible = catalog.filter((a) => a.precondition(snapshot));
    if (eligible.length === 0) {
      return catalog.find((a) => a.id === "cell.click")!;
    }

    // Context-aware weight adjustments (same heuristics as v1)
    const weights = eligible.map((a) => {
      let w = a.weight * familyMultiplier(a);
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
      // The RECORDED parameters are handed to the precondition here — this is
      // the replay path, and it is the only place they exist. See ActionDef.
      if (!def.precondition(snapshot, instance.params)) {
        log?.skipped.push(index - 1);
        continue;
      }
      return instance;
    }
    return null;
  }

  return { seed: trace.seed, next };
}
