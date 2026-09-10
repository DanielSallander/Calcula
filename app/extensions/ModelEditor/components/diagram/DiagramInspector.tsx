// FILENAME: app/extensions/ModelEditor/components/diagram/DiagramInspector.tsx
// PURPOSE: What the selected table IS, beside the diagram — its columns, the
//          relationships it takes part in, and the way to the places that can
//          change it.
// CONTEXT: READ-ONLY, PLUS NAVIGATE. Deliberately: TablesSection already owns
//          table editing and RelationshipsSection owns relationship editing, so
//          a second set of write controls here would be a second write path —
//          the drift `SectionCtx.runCommand` exists to prevent, and the thing
//          the Seam Rule is about. Clicking a table opens it where it is
//          edited; clicking a relationship opens that relationship's editor.
//
//          Selecting a node already worked and was WRITE-ONLY: the diagram set
//          `selectedTable`, and the only consumer was the node's own highlight.
//          The state was built; nothing read it. This is that consumer.

import React from "react";
import type { ModelRelationshipInfo, ModelTableInfo } from "@api";
import { Badge, styles } from "../editorShared";
import { ME, SPACE } from "../theme";

export function DiagramInspector({
  table,
  relationships,
  onOpenTable,
  onEditRelationship,
  onClose,
}: {
  table: ModelTableInfo;
  /** Every relationship in the model; the ones touching this table are picked
   *  out here rather than by the caller, so both directions are found. */
  relationships: ModelRelationshipInfo[];
  onOpenTable: (name: string) => void;
  onEditRelationship: (name: string) => void;
  onClose: () => void;
}): React.ReactElement {
  // BOTH DIRECTIONS. A dimension is almost always on the `to` side, so a
  // one-sided filter would show an empty list for exactly the tables people
  // click on most.
  const joins = relationships.filter(
    (r) => r.fromTable === table.name || r.toTable === table.name,
  );

  return (
    <aside
      data-testid="diagram-inspector"
      style={{
        width: 260,
        flexShrink: 0,
        borderLeft: `1px solid ${ME.border}`,
        background: ME.surface,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          ...styles.sectionHeader,
          padding: `${SPACE.sm}px ${SPACE.md}px`,
          borderBottom: `1px solid ${ME.border}`,
        }}
      >
        {/* A schema-qualified name ellipses at 260px ("BI.dim_cust…"), and the
            qualifier is the half that survives — so the tooltip carries the
            whole thing rather than leaving the reader to guess. */}
        <span
          title={table.name}
          style={{
            ...styles.sectionTitle,
            fontSize: 13,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {table.name}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          style={styles.smallBtn}
          data-testid="diagram-inspector-close"
          title="Close the inspector"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div style={{ overflowY: "auto", padding: SPACE.md, display: "flex", flexDirection: "column", gap: SPACE.md }}>
        <div>
          <div style={styles.label}>Columns</div>
          <div style={{ ...styles.hint, marginBottom: SPACE.xs }}>
            {table.columns.length} column{table.columns.length === 1 ? "" : "s"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {table.columns.map((c) => (
              <div
                key={c.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: SPACE.xs,
                  fontSize: 12,
                  minWidth: 0,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.name}
                </span>
                <span style={{ ...styles.hint, flexShrink: 0 }}>{c.dataType}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={styles.label}>Relationships</div>
          {joins.length === 0 ? (
            // Not decoration: a table in no relationship is exactly what the
            // problems list flags as an orphan, so the empty state says the
            // thing rather than leaving a blank.
            <div style={styles.hint}>
              This table joins nothing. Nothing can be sliced by it, and no measure on it can be
              filtered by another table.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {joins.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  data-testid={`diagram-inspector-rel-${r.name}`}
                  title="Open this relationship's editor"
                  onClick={() => onEditRelationship(r.name)}
                  style={{
                    ...styles.smallBtn,
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: SPACE.xs,
                    minWidth: 0,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.fromTable === table.name ? `→ ${r.toTable}` : `← ${r.fromTable}`}
                  </span>
                  {!r.active && <Badge tone="warn">inactive</Badge>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* The one action, and it is a navigation rather than an edit. */}
        <button
          type="button"
          style={styles.btn}
          data-testid="diagram-inspector-open-table"
          title="Open this table where its columns are edited"
          onClick={() => onOpenTable(table.name)}
        >
          Open in Tables
        </button>
      </div>
    </aside>
  );
}
