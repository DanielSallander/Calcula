//! FILENAME: app/e2e/invariants/invariants.ts
// PURPOSE: Defines state consistency invariants that must hold after every action.
//          Each invariant is a pure function that receives a snapshot and returns
//          any violations found.

import type { StateSnapshot } from "./stateSnapshot";

// ============================================================================
// Types
// ============================================================================

export interface InvariantViolation {
  /** Which invariant failed */
  invariantId: string;
  /** Human-readable description of what went wrong */
  message: string;
  /** Relevant state for debugging */
  details: Record<string, unknown>;
}

export interface Invariant {
  id: string;
  description: string;
  check: (snapshot: StateSnapshot) => InvariantViolation[];
}

// ============================================================================
// Contextual Ribbon Tab Mapping
// ============================================================================

/**
 * Maps contextual ribbon tab labels to the backend state that must exist
 * for that tab to be legitimately visible.
 *
 * To add support for a new feature: add one entry here + add its actions
 * to the action catalog. The invariant check is automatic.
 */
interface ContextualTabRule {
  /** What must be true in the logical state for this tab to be valid */
  validate: (snapshot: StateSnapshot) => boolean;
  /** What we expected to find */
  expectation: string;
}

const CONTEXTUAL_TAB_RULES: Record<string, ContextualTabRule> = {
  // --- Slicer ---
  Slicer: {
    validate: (s) => s.logical.slicers.length > 0,
    expectation: "at least one slicer must exist",
  },
  "Slicer Options": {
    validate: (s) => s.logical.slicers.length > 0,
    expectation: "at least one slicer must exist",
  },

  // --- Timeline Slicer ---
  Timeline: {
    validate: (s) => s.logical.timelines.length > 0,
    expectation: "at least one timeline slicer must exist",
  },

  // --- Charts ---
  "Chart Design": {
    validate: (s) => s.logical.charts.length > 0,
    expectation: "at least one chart must exist",
  },

  // --- Table ---
  "Table Design": {
    validate: (s) => s.logical.tables.length > 0,
    expectation: "at least one table must exist",
  },

  // --- Pivot (two tabs, same rule) ---
  "Pivot Table": {
    validate: (s) => s.logical.pivots.length > 0,
    expectation: "at least one pivot table must exist",
  },
  "Pivot Table Design": {
    validate: (s) => s.logical.pivots.length > 0,
    expectation: "at least one pivot table must exist",
  },

  // --- Sparklines (no color, but still a contextual tab) ---
  Sparkline: {
    validate: (s) => s.logical.sparklineGroups.length > 0,
    expectation: "at least one sparkline group must exist",
  },

  // Generic "Design" tab could be chart, table, or pivot — accept any
  Design: {
    validate: (s) =>
      s.logical.charts.length > 0 ||
      s.logical.tables.length > 0 ||
      s.logical.pivots.length > 0,
    expectation: "at least one chart, table, or pivot must exist",
  },
};

// ============================================================================
// Invariant Definitions
// ============================================================================

/**
 * INVARIANT: Contextual ribbon tabs should only appear when the corresponding
 * backend objects exist. If a slicer tab is visible but no slicers exist in
 * the backend, that's a state consistency bug.
 */
const contextualRibbonTabConsistency: Invariant = {
  id: "contextual-ribbon-tabs",
  description:
    "Contextual ribbon tabs (colored tabs) should only be visible when " +
    "their associated backend objects exist",
  check(snapshot) {
    const violations: InvariantViolation[] = [];
    const contextualTabs = snapshot.visual.ribbonTabs.filter(
      (t) => t.accentColor !== null
    );

    for (const tab of contextualTabs) {
      const rule = CONTEXTUAL_TAB_RULES[tab.label];
      if (!rule) {
        // Unknown contextual tab — not necessarily a violation but worth noting.
        // Skip for now to avoid false positives on new features.
        continue;
      }

      if (!rule.validate(snapshot)) {
        violations.push({
          invariantId: "contextual-ribbon-tabs",
          message:
            `Contextual tab "${tab.label}" is visible but ${rule.expectation}. ` +
            `Found: slicers=${snapshot.logical.slicers.length}, ` +
            `charts=${snapshot.logical.charts.length}, ` +
            `tables=${snapshot.logical.tables.length}, ` +
            `pivots=${snapshot.logical.pivots.length}, ` +
            `timelines=${snapshot.logical.timelines.length}, ` +
            `sparklines=${snapshot.logical.sparklineGroups.length}`,
          details: {
            tabLabel: tab.label,
            accentColor: tab.accentColor,
            slicerCount: snapshot.logical.slicers.length,
            chartCount: snapshot.logical.charts.length,
            tableCount: snapshot.logical.tables.length,
            pivotCount: snapshot.logical.pivots.length,
            timelineCount: snapshot.logical.timelines.length,
            sparklineCount: snapshot.logical.sparklineGroups.length,
          },
        });
      }
    }

    return violations;
  },
};

/**
 * INVARIANT: No uncaught JavaScript exceptions should occur during normal
 * user interaction sequences.
 */
const noJsExceptions: Invariant = {
  id: "no-js-exceptions",
  description: "No uncaught JavaScript exceptions during action sequences",
  check(snapshot) {
    return snapshot.jsExceptions.map((msg) => ({
      invariantId: "no-js-exceptions",
      message: `Uncaught JS exception: ${msg}`,
      details: { exception: msg },
    }));
  },
};

/**
 * INVARIANT: No unexpected console.error calls during normal interaction.
 * Known noise is filtered out by stateSnapshot.ts.
 */
const noConsoleErrors: Invariant = {
  id: "no-console-errors",
  description: "No unexpected console.error calls during action sequences",
  check(snapshot) {
    return snapshot.consoleErrors.map((msg) => ({
      invariantId: "no-console-errors",
      message: `Console error: ${msg.slice(0, 200)}`,
      details: { error: msg },
    }));
  },
};

// ============================================================================
// Export
// ============================================================================

/** All invariants to check after each action. */
export const ALL_INVARIANTS: Invariant[] = [
  contextualRibbonTabConsistency,
  noJsExceptions,
  noConsoleErrors,
];
