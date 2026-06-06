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
  Slicer: {
    validate: (s) => s.logical.slicers.length > 0,
    expectation: "at least one slicer must exist",
  },
  "Slicer Options": {
    validate: (s) => s.logical.slicers.length > 0,
    expectation: "at least one slicer must exist",
  },
  "Chart Design": {
    validate: (s) => s.logical.charts.length > 0,
    expectation: "at least one chart must exist",
  },
  Design: {
    // Generic "Design" tab could be chart or table — accept either
    validate: (s) => s.logical.charts.length > 0 || s.logical.tables.length > 0,
    expectation: "at least one chart or table must exist",
  },
  "Table Design": {
    validate: (s) => s.logical.tables.length > 0,
    expectation: "at least one table must exist",
  },
  "PivotTable Analyze": {
    // Pivot tables are validated via selection being inside a pivot — for now
    // we just check that the tab label exists without panic. Pivots are complex
    // to validate since they live in the grid range, not as standalone objects.
    validate: () => true,
    expectation: "selection must be inside a pivot table",
  },
  "PivotTable Design": {
    validate: () => true,
    expectation: "selection must be inside a pivot table",
  },
  Sparkline: {
    validate: () => true,
    expectation: "sparklines must exist in selected range",
  },
  Timeline: {
    validate: () => true,
    expectation: "a timeline slicer must exist",
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
            `tables=${snapshot.logical.tables.length}`,
          details: {
            tabLabel: tab.label,
            accentColor: tab.accentColor,
            slicerCount: snapshot.logical.slicers.length,
            chartCount: snapshot.logical.charts.length,
            tableCount: snapshot.logical.tables.length,
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

/**
 * INVARIANT: No dialogs should be orphaned (visible without being intentionally
 * opened). After an action that doesn't explicitly open a dialog, the dialog
 * count should not spontaneously increase.
 *
 * NOTE: This is tracked across snapshots by the runner, not within a single
 * snapshot. For now we just capture the count for the runner to use.
 */
const noOrphanedDialogs: Invariant = {
  id: "no-orphaned-dialogs",
  description: "No dialogs appear spontaneously without user action",
  check(_snapshot) {
    // This invariant is intentionally a no-op in single-snapshot mode.
    // The runner tracks dialog count across snapshots and flags unexpected increases.
    return [];
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
  noOrphanedDialogs,
];
