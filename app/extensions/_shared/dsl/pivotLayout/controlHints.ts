//! FILENAME: app/extensions/_shared/dsl/pivotLayout/controlHints.ts
// PURPOSE: Build the `@`-completion hints (DslControlHint[]) from the live
//   pane-control / ribbon-filter list — shared by every design-query editor
//   that supports @param binding (reports, charts, future visuals).

import { listControlValues, type ControlValue } from "@api/controlValues";
import type { DslControlHint } from "./pivotDslLanguage";

/** One-line preview of a control's current value, shown as completion detail. */
function describeControlValue(v: ControlValue | undefined): string | undefined {
  if (!v) return undefined;
  switch (v.kind) {
    case "text":
      return v.value;
    case "number":
      return String(v.value);
    case "boolean":
      return v.value ? "true" : "false";
    case "textList":
      return v.value.join(", ");
  }
}

/** Snapshot the named controls + ribbon filters as editor hints. */
export function buildControlHints(): DslControlHint[] {
  return listControlValues().map((c) => ({
    name: c.name,
    kind: c.source === "ribbonFilter" ? "filter" : c.controlType,
    detail: describeControlValue(c.value),
  }));
}
