//! FILENAME: app/e2e/invariants/index.ts
// PURPOSE: Barrel export for the invariant testing framework.

export { captureSnapshot, installErrorTracking } from "./stateSnapshot";
export type {
  StateSnapshot,
  LogicalState,
  VisualState,
  PivotInfo,
  TimelineInfo,
  SparklineGroupInfo,
} from "./stateSnapshot";

export { ALL_INVARIANTS } from "./invariants";
export type { Invariant, InvariantViolation } from "./invariants";

export { ACTION_CATALOG } from "./actions";
export type { Action } from "./actions";

export { createActionGenerator } from "./actionGenerator";
export type { ActionGenerator, GeneratorOptions } from "./actionGenerator";

export { InvariantRunner } from "./runner";
export type { RunnerOptions } from "./runner";

export { formatReport } from "./reporter";
export type { RunResult } from "./reporter";
