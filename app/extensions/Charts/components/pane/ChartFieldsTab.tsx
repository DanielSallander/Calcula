//! FILENAME: app/extensions/Charts/components/pane/ChartFieldsTab.tsx
// PURPOSE: A design-query chart's FIELDS tab in the object pane (WP-C S9b,
//          D-PANE): Power BI's "Build visual" wells for the chart's mark
//          (Axis / Legend / Values / Filters; a Card's Fields; a KPI's
//          Indicator / Trend axis / Goal; a Gauge's Value / Target / Minimum /
//          Maximum) over the model's field list.
// CONTEXT: Built from the SHARED field list and drop zones
//          (`_shared/components/TableFieldList`, `_shared/components/DropZone`)
//          -- never Pivot's components (lint:boundaries). The wells are a
//          view over the chart's DSL (lib/designQueryWells.ts): every drop,
//          removal, reorder and checkbox computes the NEW DSL and hands it to
//          `onCommit`, the ONE write (lib/designQueryCommit.ts). Nothing here
//          holds a second copy of the query: the wells re-derive from the
//          stored DSL on every render, so an undo, an Apply on the Design tab
//          or a script's edit shows up here as it lands.
//
//          Each well is a DropZone with its own `dropKey`, because several
//          wells share a zone type (a gauge's four slots are all VALUES): its
//          pills carry the key, so a pill dragged from Target to Minimum is a
//          MOVE, never a reorder inside the wrong well.

import React, { useCallback, useMemo } from "react";
import { DropZone } from "../../../_shared/components/DropZone";
import { TableFieldList } from "../../../_shared/components/TableFieldList";
import type {
  BiPivotModelInfo,
  DragField,
  DropZoneType,
  MeasureField,
} from "../../../_shared/components/types";
import type { ChartMark, MarkOptions } from "../../types";
import {
  chartWellKey,
  dropOnWell,
  readWells,
  removeFromWell,
  reorderWell,
  toggleColumn,
  toggleMeasure,
  usedColumnsOf,
  usedMeasuresOf,
  wellsToDsl,
  type GaugeIndexPatch,
  type WellEditResult,
  type WellsState,
} from "../../lib/designQueryWells";

export interface ChartFieldsTabProps {
  /** The connection's model (the field list and the compile context). */
  biModel: BiPivotModelInfo;
  /** The chart's stored query and mark. */
  dslText: string;
  mark: ChartMark;
  markOptions: MarkOptions | undefined;
  /** The pane is read-only (a subscribed page): nothing may write. */
  readOnly: boolean;
  readOnlyReason: string | null;
  /** A commit is in flight: further edits wait. */
  busy: boolean;
  /** Write the new query (the ONE write). */
  onCommit(dslText: string, markOptions: GaugeIndexPatch | null): void;
  /** Show a refusal in the tab's error line. */
  onError(message: string): void;
}

const noop = (): void => {};

export function ChartFieldsTab(props: ChartFieldsTabProps): React.ReactElement {
  const { biModel, dslText, mark, markOptions, readOnly, readOnlyReason, busy, onCommit, onError } = props;
  const model = useMemo(() => readWells(dslText, biModel, mark, markOptions), [dslText, biModel, mark, markOptions]);
  const canEdit = !readOnly && model.editable && !busy;
  const lockedReason = readOnly ? readOnlyReason : model.reason;

  /** Fold an edit back into DSL and commit it, or show why not. */
  const apply = useCallback(
    (edit: (state: WellsState) => WellEditResult | WellsState): void => {
      if (busy) return;
      if (!canEdit) {
        if (lockedReason) onError(lockedReason);
        return;
      }
      const result = edit({ wells: model.wells, extraValues: model.extraValues });
      const outcome: WellEditResult = "ok" in result ? result : { ok: true, state: result };
      if (!outcome.ok) {
        onError(outcome.error);
        return;
      }
      const written = wellsToDsl(model, outcome.state, biModel);
      if (!written.ok) {
        onError(written.error);
        return;
      }
      onCommit(written.dslText, written.markOptions);
    },
    [busy, canEdit, lockedReason, model, biModel, onCommit, onError],
  );

  const usedColumns = useMemo(() => usedColumnsOf(model, model), [model]);
  const usedMeasures = useMemo(() => usedMeasuresOf(model, model), [model]);

  return (
    <div data-testid="chart-fields-tab" style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      {lockedReason !== null && (
        <div
          data-testid="chart-fields-locked"
          style={{ fontSize: 11, color: "var(--text-secondary, #605e5c)", padding: "0 12px" }}
        >
          {lockedReason}
        </div>
      )}
      <div data-testid="chart-fields-wells" style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 8px" }}>
        {model.defs.map((def) => (
          <div key={def.id} data-well-id={def.id} data-well-zone={def.zone}>
            <DropZone
              zone={def.zone}
              dropKey={chartWellKey(def.id)}
              title={def.label}
              fields={[...(model.wells[def.id] ?? [])]}
              fullWidth
              placeholder={def.accepts === "measure" ? "Add a measure here" : "Add data fields here"}
              onDrop={(_zone: DropZoneType, field: DragField, insertIndex?: number) =>
                apply((s) => dropOnWell(model.defs, s, def.id, field, insertIndex, biModel))
              }
              onRemove={(_zone: DropZoneType, index: number) => apply((s) => removeFromWell(s, def.id, index))}
              onReorder={(_zone: DropZoneType, from: number, to: number) => apply((s) => reorderWell(s, def.id, from, to))}
              onMoveField={(_fromZone: DropZoneType, fromIndex: number, toZone: DropZoneType) => {
                const target = model.defs.find((d) => d.zone === toZone && d.id !== def.id);
                if (!target) {
                  onError(`This visual has no ${toZone} well.`);
                  return;
                }
                const field = model.wells[def.id]?.[fromIndex];
                if (!field) return;
                apply((s) =>
                  dropOnWell(
                    model.defs,
                    s,
                    target.id,
                    { sourceIndex: field.sourceIndex, name: field.name, isNumeric: field.isNumeric, fromZone: def.zone, fromIndex, fromKey: chartWellKey(def.id) },
                    undefined,
                    biModel,
                  ),
                );
              }}
              onDragStart={noop}
              onDragEnd={noop}
            />
          </div>
        ))}
        {model.extraValues.length > 0 && (
          <div data-testid="chart-fields-extra" style={{ fontSize: 11, color: "var(--text-secondary, #605e5c)" }}>
            {model.extraValues.length === 1
              ? "1 more value is in the query (see the Design tab)."
              : `${model.extraValues.length} more values are in the query (see the Design tab).`}
          </div>
        )}
        {model.unshownZones.length > 0 && (
          <div data-testid="chart-fields-unshown" style={{ fontSize: 11, color: "var(--text-secondary, #605e5c)" }}>
            {`The query also uses ${model.unshownZones.map((z) => z.toUpperCase()).join(", ")}, which this visual has no well for. It is kept as written.`}
          </div>
        )}
      </div>
      <div data-testid="chart-fields-list" style={{ display: "flex", flexDirection: "column", minHeight: 200, maxHeight: 420 }}>
        <TableFieldList
          biModel={biModel}
          usedColumns={usedColumns}
          usedMeasures={usedMeasures}
          onColumnToggle={(table: string, column: string, isNumeric: boolean, checked: boolean) =>
            apply((s) => toggleColumn(model.defs, s, `${table}.${column}`, isNumeric, checked))
          }
          onMeasureToggle={(measure: MeasureField, checked: boolean) =>
            apply((s) => toggleMeasure(model.defs, s, measure.name, checked, biModel))
          }
        />
      </div>
    </div>
  );
}
