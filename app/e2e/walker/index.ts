//! FILENAME: app/e2e/walker/index.ts
// PURPOSE: Barrel export for the walker v2 module.

export type { ActionDef, AnyActionDef } from "./actionCatalog";
export {
  ACTION_CATALOG,
  FULL_ACTION_CATALOG,
  EXCLUDED_UNTIL_FIXED,
  executeInstance,
  findAction,
} from "./actionCatalog";
export type { ActionInstance, ActionTrace } from "./trace";
export { createTrace, saveTrace, loadTrace, subTrace } from "./trace";
export type { ActionSource, GeneratorSourceOptions, TraceReplayLog } from "./sources";
export {
  actionFamilies,
  createGeneratorSource,
  createTraceSource,
  mulberry32,
  parseCategoryWeights,
} from "./sources";
export type {
  ActionTiming,
  CheckpointTiming,
  WalkOptions,
  WalkResult,
} from "./walkRunner";
export { WalkRunner, formatWalkReport, summarizeCoverage } from "./walkRunner";
export type {
  ReplayFn,
  ReplayOutcome,
  ShrinkOptions,
  ShrinkResult,
  ShrinkVerdict,
} from "./shrinker";
export { minimizeTrace } from "./shrinker";
export type {
  FailureBundle,
  FailureBundleOptions,
  ScriptHostProbe,
} from "./failureBundle";
export { writeFailureBundle, probeScriptHost, appLogPath } from "./failureBundle";
export { deepResetForWalk } from "./reset";
