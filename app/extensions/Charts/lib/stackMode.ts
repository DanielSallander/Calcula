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
//
//          THE COMBO (2026-10-08): Power BI's "Line and stacked column" is a
//          combo whose BAR series stack (`ComboMarkOptions.stackMode`). A combo
//          has two of the three modes — grouped and stacked; a 100% stack would
//          put its columns on a percentage scale while its line kept the value
//          scale they share. `stackModesFor` is the list a control offers, so a
//          surface never has to know that rule itself.

import type {
  ChartSpec,
  StackMode,
  BarMarkOptions,
  LineMarkOptions,
  AreaMarkOptions,
  ComboMarkOptions,
} from "../types";

/** The modes each stackable mark offers, in the order a control shows them. */
const STACK_MODES: Readonly<Record<string, readonly StackMode[]>> = {
  bar: ["none", "stacked", "percentStacked"],
  horizontalBar: ["none", "stacked", "percentStacked"],
  line: ["none", "stacked", "percentStacked"],
  area: ["none", "stacked", "percentStacked"],
  combo: ["none", "stacked"],
};

/** Whether a mark can be grouped / stacked (/ 100% stacked) at all. */
export function supportsStacking(mark: string): boolean {
  return stackModesFor(mark).length > 0;
}

/** The stack modes `mark` can draw; empty for a mark that cannot stack. */
export function stackModesFor(mark: string): StackMode[] {
  return [...(STACK_MODES[mark] ?? [])];
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
    case "combo":
      // The painter's own rule: only "stacked" stacks.
      return (opts as ComboMarkOptions).stackMode === "stacked" ? "stacked" : "none";
    default:
      return "none";
  }
}

/** Create updated markOptions with a new stack mode, preserving other fields. */
export function setStackModeInOptions(
  spec: ChartSpec,
  mode: StackMode,
): BarMarkOptions | LineMarkOptions | AreaMarkOptions | ComboMarkOptions {
  const opts = spec.markOptions ?? {};
  switch (spec.mark) {
    case "bar":
    case "horizontalBar":
      return { ...(opts as BarMarkOptions), stackMode: mode };
    case "line":
      return { ...(opts as LineMarkOptions), stackMode: mode };
    case "area":
      return { ...(opts as AreaMarkOptions), stackMode: mode, stacked: mode !== "none" };
    case "combo":
      // A mode the combo cannot draw is not written: the schema would refuse it
      // and the painter would draw it as clustered — a setting that reports
      // success and changes nothing.
      if (mode === "percentStacked") return opts as ComboMarkOptions;
      return { ...(opts as ComboMarkOptions), stackMode: mode };
    default:
      return opts as BarMarkOptions;
  }
}
