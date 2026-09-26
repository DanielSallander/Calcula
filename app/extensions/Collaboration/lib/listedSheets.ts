// FILENAME: app/extensions/Collaboration/lib/listedSheets.ts
// PURPOSE: Keep the Publish dialog's sheet selection inside the checkbox list.
// CONTEXT: The backend lists only USER sheets as checkboxes, but its
//          `defaultSheetIndices` used to be seeded into the selection verbatim.
//          An index the list does not show (a floating range's hidden backing
//          sheet) then had no checkbox to untick it, rode every push, and was
//          counted as "selected" -- so unticking the canvas that hosts the
//          floating range still published the range's cells as an orphan. The
//          backend now admits an object sheet only through its host; this is
//          the dialog's half of the same rule.

/**
 * The subset of `indices` that the checkbox list shows, in ascending order.
 * With no list yet (`sheets` undefined) nothing can be checked against, so the
 * indices pass through unchanged.
 */
export function listedIndices(
  indices: Iterable<number>,
  sheets: readonly { index: number }[] | undefined,
): number[] {
  const all = Array.from(indices);
  if (!sheets) return all.sort((a, b) => a - b);
  const shown = new Set(sheets.map((s) => s.index));
  return all.filter((i) => shown.has(i)).sort((a, b) => a - b);
}
