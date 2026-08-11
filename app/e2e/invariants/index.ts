//! FILENAME: app/e2e/invariants/index.ts
// PURPOSE: Barrel export for the invariant testing framework.
//
// WHAT IS NOT HERE ANY MORE. This module used to also export a runner, an
// action catalog and a seeded generator — a strict subset of `../walker`'s
// (27 actions against 59) with no trace, no minimiser and no failure bundle.
// Both walks now drive `../walker`; what is left here is the part that was
// never duplicated: what a snapshot IS, and what must be true of one.

export {
  captureSnapshot,
  installErrorTracking,
  drainErrors,
  getConsoleLog,
  setWalkStep,
} from "./stateSnapshot";
export type {
  StateSnapshot,
  LogicalState,
  VisualState,
  PivotInfo,
  TimelineInfo,
  SparklineGroupInfo,
  ConsoleEntry,
  ConsoleLog,
} from "./stateSnapshot";

export { ALL_INVARIANTS } from "./invariants";
export type { Invariant, InvariantViolation } from "./invariants";
