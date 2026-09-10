// FILENAME: app/extensions/ModelEditor/components/transform/StepList.tsx
// PURPOSE: The "Applied steps" rail of the transformation editor: the Source
//          row plus one row per step, with the typed add picker, reorder and
//          remove controls, and each diagnostic anchored to the row of the step
//          its zero-based `index` names.

import React from "react";
import type { TransformDiagnosticDto, TransformStepDto } from "@api";
import { SELECTION_BG, styles } from "../editorShared";
import { STEP_GROUPS, STEP_TYPES, describeStep, stepDetail } from "./stepKit";
import { ME } from "../theme";

/** The step list's Source row — the raw rows the connector returned, before
 *  any step. Previewing it is `asOfStep: -1`. */
export const SOURCE_ROW = -1;

export function StepList({
  steps,
  selected,
  diagnostics,
  readOnly,
  onSelect,
  onAdd,
  onRemove,
  onMove,
}: {
  steps: TransformStepDto[];
  /** SOURCE_ROW (-1) for the source sample, else the zero-based step index. */
  selected: number;
  diagnostics: TransformDiagnosticDto[];
  readOnly: boolean;
  onSelect: (index: number) => void;
  onAdd: (type: string) => void;
  onRemove: (index: number) => void;
  /** delta is -1 (up) or +1 (down). */
  onMove: (index: number, delta: number) => void;
}): React.ReactElement {
  const diagnosticsFor = (index: number): TransformDiagnosticDto[] =>
    diagnostics.filter((d) => d.index === index);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ ...styles.label, marginBottom: 4 }}>Applied steps</div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          border: `1px solid ${ME.border}`,
          borderRadius: 4,
          background: ME.surface,
        }}
      >
        <div
          style={{
            ...styles.listRow,
            borderRadius: 0,
            background: selected === SOURCE_ROW ? SELECTION_BG : undefined,
          }}
          onClick={() => onSelect(SOURCE_ROW)}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>Source</div>
          <div style={{ ...styles.muted, fontSize: 11 }}>Rows as the connector returns them</div>
        </div>

        {steps.map((step, i) => {
          const rowDiagnostics = diagnosticsFor(i);
          const hasError = rowDiagnostics.some((d) => d.severity === "error");
          const detail = stepDetail(step);
          return (
            <div
              key={i}
              style={{
                ...styles.listRow,
                borderRadius: 0,
                background: selected === i ? SELECTION_BG : undefined,
              }}
              onClick={() => onSelect(i)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ ...styles.hint, width: 16, textAlign: "right", flexShrink: 0 }}>
                  {i + 1}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {describeStep(step)}
                </span>
                {hasError && (
                  <span
                    title={rowDiagnostics.map((d) => d.message).join("\n")}
                    style={{ color: ME.dangerFg, fontWeight: 700, flexShrink: 0 }}
                  >
                    !
                  </span>
                )}
                <button
                  style={styles.smallBtn}
                  disabled={readOnly || i === 0}
                  title="Move up"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(i, -1);
                  }}
                >
                  &uarr;
                </button>
                <button
                  style={styles.smallBtn}
                  disabled={readOnly || i === steps.length - 1}
                  title="Move down"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(i, 1);
                  }}
                >
                  &darr;
                </button>
                <button
                  style={styles.smallBtn}
                  disabled={readOnly}
                  title="Remove this step"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(i);
                  }}
                >
                  &times;
                </button>
              </div>
              {detail && (
                <div
                  style={{
                    ...styles.muted,
                    fontSize: 11,
                    marginLeft: 22,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={detail}
                >
                  {detail}
                </div>
              )}
              {rowDiagnostics.map((d, j) => (
                <div
                  key={j}
                  style={{
                    marginLeft: 22,
                    marginTop: 2,
                    fontSize: 11,
                    color: d.severity === "error" ? ME.dangerFg : ME.warnFg,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {d.message}
                </div>
              ))}
            </div>
          );
        })}

        {steps.length === 0 && (
          <div style={{ ...styles.hint, padding: "6px 8px" }}>
            No steps yet — the table loads the source rows unchanged.
          </div>
        )}
      </div>

      <select
        style={{ ...styles.input, marginTop: 6 }}
        value=""
        disabled={readOnly}
        title="Add a step to the end of the pipeline"
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="">+ Add step…</option>
        {STEP_GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {STEP_TYPES.filter((t) => t.group === group).map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div style={{ ...styles.hint, marginTop: 4 }}>
        A new step is appended to the end, then selected.
      </div>
    </div>
  );
}
