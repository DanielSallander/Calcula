//! FILENAME: app/extensions/Reports/lib/paramSubstitution.ts
// PURPOSE: Resolve `@ControlName` parameters in a report's design-query DSL to the
//   current pane-control value BEFORE compiling — so a report's FILTERS can be
//   driven interactively by a dropdown/slider/checkbox. Pure text substitution
//   (no DSL grammar change): `@Style` -> `("W")`, then the normal compiler runs.
// V1: one `@param` per FILTERS line; an unset control drops that FILTERS line
//   (= "show all" for that field). Multiple filters on one line is a future refine.

import type { ControlValue } from "@api/controlValues";

/** Format a control value as a DSL value list, e.g. `("W")` or `("A", "B")`. */
function formatValueList(v: ControlValue): string {
  switch (v.kind) {
    case "text":
      return `("${escapeQuotes(v.value)}")`;
    case "number":
      return `("${v.value}")`;
    case "boolean":
      return `("${v.value ? "TRUE" : "FALSE"}")`;
    case "textList":
      return v.value.length ? `(${v.value.map((s) => `"${escapeQuotes(s)}"`).join(", ")})` : "";
  }
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '""');
}

/** True when a control value means "no selection / all" (drops the filter). */
function isAll(v: ControlValue | undefined): boolean {
  if (!v) return true;
  if (v.kind === "textList") return v.value.length === 0;
  if (v.kind === "text") return v.value === "" || v.value === "(All)";
  return false;
}

/** True if the DSL text references any `@Control` parameter. */
export function hasControlParams(dslText: string): boolean {
  return /@[A-Za-z_]\w*/.test(dslText);
}

/**
 * Substitute `@ControlName` parameters with their current control values.
 * `resolve(name)` returns the control's value (undefined if missing).
 */
export function substituteControlParams(
  dslText: string,
  resolve: (name: string) => ControlValue | undefined,
): string {
  const lines = dslText.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const names = [...line.matchAll(/@([A-Za-z_]\w*)/g)].map((m) => m[1]);
    if (names.length === 0) {
      out.push(line);
      continue;
    }
    const isFilterLine = /^\s*FILTERS\s*:/i.test(line);

    // If any referenced control on a FILTERS line is unset, drop the line
    // (that field is unfiltered → all values shown).
    if (isFilterLine && names.some((n) => isAll(resolve(n)))) {
      continue;
    }

    let newLine = line;
    for (const name of names) {
      const val = resolve(name);
      const replacement = val ? formatValueList(val) : "";
      newLine = newLine.replace(new RegExp(`@${name}\\b`), replacement);
    }
    out.push(newLine);
  }

  return out.join("\n");
}
