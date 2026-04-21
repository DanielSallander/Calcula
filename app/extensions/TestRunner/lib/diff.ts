//! FILENAME: app/extensions/TestRunner/lib/diff.ts
// PURPOSE: Compare two cell state maps and produce a human-readable diff.
// CONTEXT: Used by TestContext.diffStates() to show what changed between snapshots.

import type { CellData } from "@api/types";

/**
 * Compare two cell maps and produce a compact, readable diff string.
 * Reports added cells, removed cells, and value/formula changes.
 */
export function diffCellMaps(
  a: Map<string, CellData>,
  b: Map<string, CellData>,
): string {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [addr, cellB] of b) {
    const cellA = a.get(addr);
    if (!cellA) {
      added.push(`  + ${addr}: ${describeCell(cellB)}`);
      continue;
    }
    const diffs = cellDiffs(cellA, cellB);
    if (diffs.length > 0) {
      changed.push(`  * ${addr}: ${diffs.join(", ")}`);
    }
  }

  for (const addr of a.keys()) {
    if (!b.has(addr)) {
      removed.push(`  - ${addr}: ${describeCell(a.get(addr)!)}`);
    }
  }

  const sections: string[] = [];
  sections.push(`State diff: ${a.size} cells -> ${b.size} cells`);
  if (added.length) sections.push(`Added:\n${added.join("\n")}`);
  if (removed.length) sections.push(`Removed:\n${removed.join("\n")}`);
  if (changed.length) sections.push(`Changed:\n${changed.join("\n")}`);
  if (!added.length && !removed.length && !changed.length) {
    sections.push("(no changes)");
  }
  return sections.join("\n");
}

function cellDiffs(a: CellData, b: CellData): string[] {
  const diffs: string[] = [];
  if (a.display !== b.display) {
    diffs.push(`display: "${a.display}" -> "${b.display}"`);
  }
  if ((a.formula ?? "") !== (b.formula ?? "")) {
    diffs.push(`formula: ${a.formula ?? "none"} -> ${b.formula ?? "none"}`);
  }
  if (a.styleIndex !== b.styleIndex) {
    diffs.push(`style: ${a.styleIndex} -> ${b.styleIndex}`);
  }
  return diffs;
}

function describeCell(cell: CellData): string {
  const parts: string[] = [];
  if (cell.formula) {
    parts.push(`formula=${cell.formula}`);
  }
  parts.push(`display="${cell.display}"`);
  if (cell.styleIndex > 0) {
    parts.push(`style=${cell.styleIndex}`);
  }
  return parts.join(" ");
}
