//! FILENAME: app/extensions/Charts/components/FormatAxisDialog.tsx
// PURPOSE: Comprehensive Format Axis dialog (Excel-compatible).
// CONTEXT: Opened via right-click context menu or double-click on axis.
//          Provides axis options: bounds, units, scale type, tick marks,
//          labels, line styling, display units, and number format.

import React, { useState, useCallback } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api";
import { emitAppEvent, AppEvents } from "@api/events";

import type {
  ChartSpec, AxisSpec, TickMarkType, AxisLabelPosition, DisplayUnit, AxisCrossesAt,
} from "../types";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { ChartEvents } from "../lib/chartEvents";

// ============================================================================
// Styles
// ============================================================================

const s = {
  overlay: css`
    position: fixed;
    inset: 0;
    z-index: 1050;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  dialog: css`
    background: #fff;
    border-radius: 8px;
    width: 380px;
    max-height: 80vh;
    overflow-y: auto;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #e0e0e0;
    font-weight: 600;
    font-size: 14px;
  `,
  close: css`
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    color: #666;
    padding: 2px 6px;
    border-radius: 3px;
    &:hover { background: #e8e8e8; }
  `,
  body: css`
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  sectionTitle: css`
    font-weight: 600;
    font-size: 11px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    border-bottom: 1px solid #eee;
    padding-bottom: 4px;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  `,
  label: css`
    width: 100px;
    flex-shrink: 0;
    color: #555;
  `,
  input: css`
    flex: 1;
    padding: 4px 8px;
    border: 1px solid #ccc;
    border-radius: 3px;
    font-size: 12px;
    min-width: 0;
  `,
  select: css`
    flex: 1;
    padding: 4px 6px;
    border: 1px solid #ccc;
    border-radius: 3px;
    font-size: 12px;
    background: #fff;
    cursor: pointer;
    min-width: 0;
  `,
  colorInput: css`
    width: 36px;
    height: 24px;
    padding: 1px;
    border: 1px solid #ccc;
    border-radius: 3px;
    cursor: pointer;
  `,
  checkbox: css`
    cursor: pointer;
    margin: 0;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid #e0e0e0;
  `,
  btn: css`
    padding: 5px 16px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 12px;
    &:hover { background: #f0f0f0; }
  `,
  btnPrimary: css`
    padding: 5px 16px;
    border: 1px solid #005fb8;
    border-radius: 4px;
    background: #005fb8;
    color: #fff;
    cursor: pointer;
    font-size: 12px;
    &:hover { background: #004a99; }
  `,
};

// ============================================================================
// Component
// ============================================================================

export function FormatAxisDialog({ onClose, data }: DialogProps): React.ReactElement {
  const chartId = data?.chartId as number | undefined;
  const axisType = data?.axisType as "x" | "y" | undefined;

  const chart = chartId != null ? getChartById(chartId) : undefined;
  const spec = chart?.spec;
  const isValueAxis = axisType === "y";
  const axisLabel = axisType === "x" ? "Horizontal (Category)" : "Vertical (Value)";

  const currentAxis = spec ? (axisType === "x" ? spec.xAxis : spec.yAxis) : null;

  // Local state for all fields
  const [title, setTitle] = useState(currentAxis?.title ?? "");
  const [hasTitle, setHasTitle] = useState(currentAxis?.title != null);
  const [showLabels, setShowLabels] = useState(currentAxis?.showLabels !== false);
  const [labelAngle, setLabelAngle] = useState(String(currentAxis?.labelAngle ?? 0));
  const [gridLines, setGridLines] = useState(currentAxis?.gridLines ?? false);
  const [minVal, setMinVal] = useState(currentAxis?.min != null ? String(currentAxis.min) : "");
  const [maxVal, setMaxVal] = useState(currentAxis?.max != null ? String(currentAxis.max) : "");
  const [majorUnit, setMajorUnit] = useState(currentAxis?.majorUnit != null ? String(currentAxis.majorUnit) : "");
  const [minorUnit, setMinorUnit] = useState(currentAxis?.minorUnit != null ? String(currentAxis.minorUnit) : "");
  const [scaleType, setScaleType] = useState(currentAxis?.scale?.type ?? "linear");
  const [reverse, setReverse] = useState(currentAxis?.scale?.reverse ?? false);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>(currentAxis?.displayUnit ?? "none");
  const [showDisplayUnitLabel, setShowDisplayUnitLabel] = useState(currentAxis?.showDisplayUnitLabel ?? false);
  const [majorTickMark, setMajorTickMark] = useState<TickMarkType>(currentAxis?.majorTickMark ?? "outside");
  const [minorTickMark, setMinorTickMark] = useState<TickMarkType>(currentAxis?.minorTickMark ?? "none");
  const [labelPosition, setLabelPosition] = useState<AxisLabelPosition>(currentAxis?.labelPosition ?? "nextToAxis");
  const [crossesAt, setCrossesAt] = useState<AxisCrossesAt>(currentAxis?.crossesAt ?? "auto");
  const [crossesAtValue, setCrossesAtValue] = useState(currentAxis?.crossesAtValue != null ? String(currentAxis.crossesAtValue) : "0");
  const [tickFormat, setTickFormat] = useState(currentAxis?.tickFormat ?? "");
  const [showLine, setShowLine] = useState(currentAxis?.showLine !== false);
  const [lineColor, setLineColor] = useState(currentAxis?.lineColor ?? "#666666");
  const [lineWidth, setLineWidth] = useState(String(currentAxis?.lineWidth ?? 1));

  const handleApply = useCallback(() => {
    if (chartId == null || !spec || !axisType) return;

    const axisKey = axisType === "x" ? "xAxis" : "yAxis";
    const axis = axisType === "x" ? spec.xAxis : spec.yAxis;

    const updated: AxisSpec = {
      ...axis,
      title: hasTitle ? (title || null) : null,
      showLabels,
      labelAngle: parseInt(labelAngle, 10) || 0,
      gridLines,
      min: minVal !== "" ? parseFloat(minVal) : null,
      max: maxVal !== "" ? parseFloat(maxVal) : null,
      majorUnit: majorUnit !== "" ? parseFloat(majorUnit) : null,
      minorUnit: minorUnit !== "" ? parseFloat(minorUnit) : null,
      scale: {
        ...(axis.scale ?? {}),
        type: scaleType as any,
        reverse,
      },
      displayUnit,
      showDisplayUnitLabel,
      majorTickMark,
      minorTickMark,
      labelPosition,
      crossesAt,
      crossesAtValue: crossesAtValue !== "" ? parseFloat(crossesAtValue) : undefined,
      tickFormat: tickFormat || undefined,
      showLine,
      lineColor: lineColor !== "#666666" ? lineColor : undefined,
      lineWidth: parseFloat(lineWidth) !== 1 ? parseFloat(lineWidth) : undefined,
    };

    updateChartSpec(chartId, { [axisKey]: updated });
    invalidateChartCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
    emitAppEvent(AppEvents.GRID_REFRESH);
    onClose();
  }, [chartId, axisType, spec, hasTitle, title, showLabels, labelAngle, gridLines, minVal, maxVal,
    majorUnit, minorUnit, scaleType, reverse, displayUnit, showDisplayUnitLabel,
    majorTickMark, minorTickMark, labelPosition, crossesAt, crossesAtValue,
    tickFormat, showLine, lineColor, lineWidth, onClose]);

  if (!spec || chartId == null || !axisType) {
    return (
      <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className={s.dialog}>
          <div className={s.header}>Format Axis<button className={s.close} onClick={onClose}>X</button></div>
          <div className={s.body}><p>No axis selected.</p></div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.dialog} onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter") handleApply(); }}>
        <div className={s.header}>
          Format Axis - {axisLabel}
          <button className={s.close} onClick={onClose}>X</button>
        </div>

        <div className={s.body}>
          {/* ---- AXIS OPTIONS ---- */}
          <div className={s.section}>
            <div className={s.sectionTitle}>Axis Options</div>

            {/* Title */}
            <div className={s.row}>
              <input type="checkbox" className={s.checkbox} checked={hasTitle} onChange={(e) => setHasTitle(e.target.checked)} />
              <span className={s.label}>Axis Title</span>
              {hasTitle && (
                <input className={s.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Axis title..." />
              )}
            </div>

            {/* Bounds (value axis) */}
            {isValueAxis && (
              <>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Minimum</span>
                  <input className={s.input} value={minVal} onChange={(e) => setMinVal(e.target.value)} placeholder="Auto" style={{ width: 80 }} />
                </div>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Maximum</span>
                  <input className={s.input} value={maxVal} onChange={(e) => setMaxVal(e.target.value)} placeholder="Auto" style={{ width: 80 }} />
                </div>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Major Unit</span>
                  <input className={s.input} value={majorUnit} onChange={(e) => setMajorUnit(e.target.value)} placeholder="Auto" style={{ width: 80 }} />
                </div>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Minor Unit</span>
                  <input className={s.input} value={minorUnit} onChange={(e) => setMinorUnit(e.target.value)} placeholder="Auto" style={{ width: 80 }} />
                </div>
              </>
            )}

            {/* Scale Type (value axis) */}
            {isValueAxis && (
              <div className={s.row}>
                <span style={{ width: 16 }} />
                <span className={s.label}>Scale Type</span>
                <select className={s.select} value={scaleType} onChange={(e) => setScaleType(e.target.value)}>
                  <option value="linear">Linear</option>
                  <option value="log">Logarithmic</option>
                  <option value="pow">Power</option>
                  <option value="sqrt">Square Root</option>
                </select>
              </div>
            )}

            {/* Display Units (value axis) */}
            {isValueAxis && (
              <>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Display Units</span>
                  <select className={s.select} value={displayUnit} onChange={(e) => setDisplayUnit(e.target.value as DisplayUnit)}>
                    <option value="none">None</option>
                    <option value="hundreds">Hundreds</option>
                    <option value="thousands">Thousands</option>
                    <option value="tenThousands">Ten Thousands</option>
                    <option value="hundredThousands">Hundred Thousands</option>
                    <option value="millions">Millions</option>
                    <option value="billions">Billions</option>
                    <option value="trillions">Trillions</option>
                  </select>
                </div>
                {displayUnit !== "none" && (
                  <div className={s.row}>
                    <input type="checkbox" className={s.checkbox} checked={showDisplayUnitLabel} onChange={(e) => setShowDisplayUnitLabel(e.target.checked)} />
                    <span>Show display unit label on chart</span>
                  </div>
                )}
              </>
            )}

            {/* Reverse */}
            <div className={s.row}>
              <input type="checkbox" className={s.checkbox} checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
              <span>Values in reverse order</span>
            </div>

            {/* Crosses At */}
            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Crosses At</span>
              <select className={s.select} value={crossesAt} onChange={(e) => setCrossesAt(e.target.value as AxisCrossesAt)}>
                <option value="auto">Automatic</option>
                <option value="min">Minimum</option>
                <option value="max">Maximum</option>
                <option value="value">At Value...</option>
              </select>
            </div>
            {crossesAt === "value" && (
              <div className={s.row}>
                <span style={{ width: 16 }} />
                <span className={s.label}>Cross Value</span>
                <input className={s.input} value={crossesAtValue} onChange={(e) => setCrossesAtValue(e.target.value)} style={{ width: 80 }} />
              </div>
            )}
          </div>

          {/* ---- TICK MARKS ---- */}
          <div className={s.section}>
            <div className={s.sectionTitle}>Tick Marks</div>

            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Major Type</span>
              <select className={s.select} value={majorTickMark} onChange={(e) => setMajorTickMark(e.target.value as TickMarkType)}>
                <option value="none">None</option>
                <option value="inside">Inside</option>
                <option value="outside">Outside</option>
                <option value="cross">Cross</option>
              </select>
            </div>

            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Minor Type</span>
              <select className={s.select} value={minorTickMark} onChange={(e) => setMinorTickMark(e.target.value as TickMarkType)}>
                <option value="none">None</option>
                <option value="inside">Inside</option>
                <option value="outside">Outside</option>
                <option value="cross">Cross</option>
              </select>
            </div>
          </div>

          {/* ---- LABELS ---- */}
          <div className={s.section}>
            <div className={s.sectionTitle}>Labels</div>

            <div className={s.row}>
              <input type="checkbox" className={s.checkbox} checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              <span>Show Axis Labels</span>
            </div>

            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Position</span>
              <select className={s.select} value={labelPosition} onChange={(e) => setLabelPosition(e.target.value as AxisLabelPosition)}>
                <option value="nextToAxis">Next to Axis</option>
                <option value="high">High</option>
                <option value="low">Low</option>
                <option value="none">None</option>
              </select>
            </div>

            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Label Angle</span>
              <input className={s.input} type="number" value={labelAngle} onChange={(e) => setLabelAngle(e.target.value)} style={{ width: 60 }} min={-90} max={90} />
              <span style={{ fontSize: 11, color: "#888" }}>degrees</span>
            </div>

            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Number Format</span>
              <input className={s.input} value={tickFormat} onChange={(e) => setTickFormat(e.target.value)} placeholder='e.g. $,.0f or .1%' />
            </div>
          </div>

          {/* ---- AXIS LINE ---- */}
          <div className={s.section}>
            <div className={s.sectionTitle}>Axis Line</div>

            <div className={s.row}>
              <input type="checkbox" className={s.checkbox} checked={showLine} onChange={(e) => setShowLine(e.target.checked)} />
              <span>Show Axis Line</span>
            </div>

            {showLine && (
              <>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Color</span>
                  <input type="color" className={s.colorInput} value={lineColor} onChange={(e) => setLineColor(e.target.value)} />
                </div>
                <div className={s.row}>
                  <span style={{ width: 16 }} />
                  <span className={s.label}>Width</span>
                  <input className={s.input} type="number" value={lineWidth} onChange={(e) => setLineWidth(e.target.value)} style={{ width: 60 }} min={0.5} max={10} step={0.5} />
                  <span style={{ fontSize: 11, color: "#888" }}>px</span>
                </div>
              </>
            )}

            <div className={s.row}>
              <input type="checkbox" className={s.checkbox} checked={gridLines} onChange={(e) => setGridLines(e.target.checked)} />
              <span>Show Gridlines</span>
            </div>
          </div>
        </div>

        <div className={s.footer}>
          <button className={s.btn} onClick={onClose}>Cancel</button>
          <button className={s.btnPrimary} onClick={handleApply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
