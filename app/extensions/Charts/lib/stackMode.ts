//! FILENAME: app/extensions/Charts/lib/stackMode.ts
// PURPOSE: Read and write a chart's stacking mode (grouped / stacked / 100%).
// CONTEXT: The mode lives in a DIFFERENT place per mark: bar, horizontal bar
//          and line keep `markOptions.stackMode`; area also carries the legacy
//          `stacked` boolean, which older specs set without a stackMode. These
//          two helpers are the one reader and the one writer, so the Chart
//          Design band's Layout cluster, and anything that later wants the same
//          answer, cannot disagree about which field wins.
//
//          Moved verbatim from components/ChartDesignSections.tsx when the
//          Chart Design tab was rebuilt on the Clusters control grammar; only
//          `supportsStacking` is new, and it states the rule the old Stacking
//          section inlined in two places.

import type {
  ChartSpec,
  StackMode,
  BarMarkOptions,
  LineMarkOptions,
  AreaMarkOptions,
} from "../types";

/** The marks whose markOptions carry a stack mode. */
const STACKABLE_MARKS: ReadonlySet<string> = new Set(["bar", "horizontalBar", "line", "area"]);

/** Whether a mark can be grouped / stacked / 100% stacked at all. */
export function supportsStacking(mark: string): boolean {
  return STACKABLE_MARKS.has(mark);
}

/** Read the current stack mode from spec.markOptions based on chart type. */
export function getStackModeFromSpec(spec: ChartSpec): StackMode {
  const opts = spec.markOptions ?? {};
  switch (spec.mark) {
    case "bar":
    case "horizontalBar":
      return (opts as BarMarkOptions).stackMode ?? "none";
    case "line":
      return (opts as LineMarkOptions).stackMode ?? "none";
    case "area": {
      const areaOpts = opts as AreaMarkOptions;
      return areaOpts.stackMode ?? (areaOpts.stacked ? "stacked" : "none");
    }
    default:
      return "none";
  }
}

/** Create updated markOptions with a new stack mode, preserving other fields. */
export function setStackModeInOptions(spec: ChartSpec, mode: StackMode): BarMarkOptions | LineMarkOptions | AreaMarkOptions {
  const opts = spec.markOptions ?? {};
  switch (spec.mark) {
    case "bar":
    case "horizontalBar":
      return { ...(opts as BarMarkOptions), stackMode: mode };
    case "line":
      return { ...(opts as LineMarkOptions), stackMode: mode };
    case "area":
      return { ...(opts as AreaMarkOptions), stackMode: mode, stacked: mode !== "none" };
    default:
      return opts as BarMarkOptions;
  }
}
