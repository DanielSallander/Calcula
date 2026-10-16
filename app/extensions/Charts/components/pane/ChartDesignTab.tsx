//! FILENAME: app/extensions/Charts/components/pane/ChartDesignTab.tsx
// PURPOSE: A design-query chart's DESIGN tab in the object pane (WP-C S9b,
//          D-PANE): the query as text, in the shared pivot-layout DSL editor
//          (the Charts adapter, sized to the query), with Apply.
// CONTEXT: The text being typed is a DRAFT held by the build host
//          (ChartDesignQueryBuild), so switching to Fields and back keeps it.
//          It is committed -- through the ONE write, lib/designQueryCommit.ts
//          -- on Apply and when focus LEAVES the editor for something outside
//          it (Monaco's own suggest / hover widgets live in a body-level
//          overflow node, so a move into them is not a blur). A query that
//          does not compile is refused with the compiler's sentences in the
//          error line and nothing is written: the chart keeps drawing the last
//          good query.

import React, { useCallback, useRef } from "react";
import { DesignQueryEditor } from "../DesignQueryEditor";

export interface ChartDesignTabProps {
  /** The draft text. */
  value: string;
  onChange(value: string): void;
  /** The connection whose model drives completion. */
  connectionId: string;
  /** The draft differs from the stored query. */
  dirty: boolean;
  /** A commit is in flight. */
  busy: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  /** Commit the draft (Apply, or focus leaving the editor). */
  onApply(): void;
  /** Throw the draft away and show the stored query again. */
  onRevert(): void;
}

/** Whether focus moving to `next` stays inside the editor (its box or Monaco's widgets). */
function staysInEditor(box: HTMLElement | null, next: EventTarget | null): boolean {
  if (!(next instanceof Node)) return false;
  if (box?.contains(next)) return true;
  // Monaco's suggest list / hover render into a body-level node with this class.
  return next instanceof Element && next.closest(".monaco-editor") !== null;
}

export function ChartDesignTab(props: ChartDesignTabProps): React.ReactElement {
  const { value, onChange, connectionId, dirty, busy, readOnly, readOnlyReason, onApply, onRevert } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (readOnly || busy || !dirty) return;
      if (staysInEditor(boxRef.current, e.relatedTarget)) return;
      onApply();
    },
    [readOnly, busy, dirty, onApply],
  );

  return (
    <div data-testid="chart-design-tab" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 12px" }}>
      <div
        ref={boxRef}
        data-testid="chart-design-editor"
        onBlur={handleBlur}
        aria-disabled={readOnly || undefined}
        style={readOnly ? { pointerEvents: "none", opacity: 0.6 } : undefined}
      >
        <DesignQueryEditor
          value={value}
          onChange={(v) => {
            if (!readOnly) onChange(v);
          }}
          connectionId={connectionId}
          autoHeight={{ min: 120, max: 420 }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          data-testid="chart-design-apply"
          disabled={readOnly || busy || !dirty}
          title={readOnly ? (readOnlyReason ?? undefined) : undefined}
          onClick={onApply}
        >
          Apply
        </button>
        <button
          type="button"
          data-testid="chart-design-revert"
          disabled={readOnly || busy || !dirty}
          onClick={onRevert}
        >
          Revert
        </button>
        {dirty && !busy && (
          <span style={{ fontSize: 11, color: "var(--text-secondary, #605e5c)" }}>Not applied yet.</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary, #605e5c)" }}>
        Ctrl+Space suggests fields and measures. The query runs against the connection's model; the data lives in the
        chart.
      </div>
    </div>
  );
}
