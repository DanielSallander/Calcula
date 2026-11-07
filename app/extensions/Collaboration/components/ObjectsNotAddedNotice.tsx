//! FILENAME: app/extensions/Collaboration/components/ObjectsNotAddedNotice.tsx
// PURPOSE: Say which charts and ribbon filters a subscribe or a refresh did NOT
//          add because the workbook already holds one under that id (or, for a
//          ribbon filter, under that name) -- BUG-0734.
// CONTEXT: Two applications used to be able to carry one chart or ribbon-filter
//          id (an application published from another's working copy kept the
//          original's ids). A subscriber to both kept the first and the second
//          was skipped with nothing said. The publish now gives such a copy ids
//          of its own; Rust still never clobbers an object it already holds,
//          and returns one sentence per object it did not add
//          (`PullResponse::objects_not_added`, `RefreshResult::objects_not_added`),
//          shown where the pull or refresh reports its result.

import React from "react";

const boxStyle: React.CSSProperties = {
  fontSize: "12px",
  margin: "8px 0",
  padding: "6px 8px",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
};

/** The heading line for `count` objects not added. Pure, for tests and callers. */
export function describeObjectsNotAdded(count: number): string {
  return count === 1
    ? "1 chart or filter from this application was not added, because this workbook already has one like it:"
    : `${count} charts or filters from this application were not added, because this workbook already has ones like them:`;
}

export function ObjectsNotAddedNotice({
  objects,
  testId,
}: {
  /** One sentence per object not added, as the backend wrote it. */
  objects: readonly string[] | null | undefined;
  testId?: string;
}): React.ReactElement | null {
  if (!objects || objects.length === 0) return null;
  return (
    <div style={boxStyle} data-testid={testId ?? "objects-not-added"}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>Charts and filters</div>
      <div>{describeObjectsNotAdded(objects.length)}</div>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {objects.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
