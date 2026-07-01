//! FILENAME: app/extensions/Animation/components/AnimationDialog.tsx
// PURPOSE: Create / edit a saved AnimationSpec. Supports two driver types:
//          - Clock cell: a driver cell swept from→to by step.
//          - Chart param: a chart's bindable param swept over its declared range/
//            options (derived from the param's bind).
//          Saving persists it (animationStore) and loads it into the engine.
// DATA: opened via showDialog("animation.editor", { editingId? , prefill? }).
import React, { useEffect, useMemo, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { getActiveSheet } from "@api/lib";
import { listAnimatableCharts, listChartParams, type ChartParamBinding } from "@api/chartParams";
import { parseA1, toA1 } from "../lib/a1";
import { getAnimation, upsertAnimation, newAnimationId } from "../lib/animationStore";
import { playbackEngine } from "../lib/animationEngine";
import type { AnimationSpec, ChartParamSequence, DriverKind } from "../types";

/** Dialog id shared by the registration (index.ts) and the openers (panel). */
export const ANIMATION_DIALOG_ID = "animation.editor";

/** Derive the sweep sequence a chart param visits from its bind declaration. */
function deriveSequence(bind?: ChartParamBinding): ChartParamSequence | null {
  if (!bind) return null;
  if (bind.input === "stepper") {
    const from = bind.min ?? 0;
    const to = bind.max ?? from + 10;
    const step = bind.step ?? 1;
    return { kind: "range", from, to, step };
  }
  if (bind.options && bind.options.length > 0) return { kind: "options", options: bind.options };
  return null;
}

function sequencePreview(seq: ChartParamSequence | null): string {
  if (!seq) return "this param has no bindable range";
  if (seq.kind === "options") return `cycles ${seq.options.length} options: ${seq.options.join(", ")}`;
  const span = Math.abs(seq.to - seq.from);
  const frames = seq.step === 0 ? 1 : Math.floor(span / Math.abs(seq.step) + 1e-9) + 1;
  return `sweeps ${seq.from} → ${seq.to} step ${seq.step} (${frames} frames)`;
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 400,
  background: "var(--panel-bg, #fff)",
  color: "var(--text-color, #1a1a1a)",
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  borderBottom: "1px solid var(--border-color, #e0e0e0)",
  fontWeight: 600,
};
const body: React.CSSProperties = { padding: 14, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 };
const footer: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "10px 14px",
  borderTop: "1px solid var(--border-color, #e0e0e0)",
};
const field: React.CSSProperties = {
  width: "100%",
  height: 26,
  boxSizing: "border-box",
  padding: "0 8px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
};
const labelStyle: React.CSSProperties = { fontSize: 11, opacity: 0.75, marginBottom: 3 };
const button: React.CSSProperties = {
  height: 28,
  padding: "0 14px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
  background: "var(--button-bg, #fff)",
  cursor: "pointer",
};
const primary: React.CSSProperties = {
  ...button,
  background: "var(--accent-color, #217346)",
  borderColor: "var(--accent-color, #217346)",
  color: "#fff",
};

export function AnimationDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
  const editingId = typeof data?.editingId === "string" ? data.editingId : null;

  const [driverType, setDriverType] = useState<DriverKind>("clockCell");
  const [name, setName] = useState("");
  const [fpsStr, setFpsStr] = useState("12");
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clock-cell fields.
  const [cellRef, setCellRef] = useState("B1");
  const [fromStr, setFromStr] = useState("0");
  const [toStr, setToStr] = useState("100");
  const [stepStr, setStepStr] = useState("1");

  // Chart-param fields.
  const [chartId, setChartId] = useState("");
  const [paramName, setParamName] = useState("");

  const charts = useMemo(() => (driverType === "chartParam" ? listAnimatableCharts() : []), [driverType, isOpen]);
  const params = useMemo(
    () => (chartId ? listChartParams(chartId).filter((p) => p.bind) : []),
    [chartId, isOpen, driverType],
  );
  const selectedParam = params.find((p) => p.name === paramName);
  const derivedSeq = selectedParam ? deriveSequence(selectedParam.bind) : null;

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    const existing = editingId ? getAnimation(editingId) : undefined;
    if (existing?.driver === "clockCell" && existing.clockCell) {
      setDriverType("clockCell");
      setName(existing.name);
      setCellRef(toA1(existing.clockCell.row, existing.clockCell.col));
      setFromStr(String(existing.clockCell.from));
      setToStr(String(existing.clockCell.to));
      setStepStr(String(existing.clockCell.step));
      setFpsStr(String(existing.playback.fps));
      setLoop(existing.playback.loop);
      return;
    }
    if (existing?.driver === "chartParam" && existing.chartParam) {
      setDriverType("chartParam");
      setName(existing.name);
      setChartId(existing.chartParam.chartId);
      setParamName(existing.chartParam.paramName);
      setFpsStr(String(existing.playback.fps));
      setLoop(existing.playback.loop);
      return;
    }
    const p = (data?.prefill ?? {}) as Record<string, unknown>;
    setDriverType("clockCell");
    setName(typeof p.name === "string" ? p.name : "");
    setCellRef(typeof p.cellRef === "string" ? p.cellRef : "B1");
    setFromStr(p.from != null ? String(p.from) : "0");
    setToStr(p.to != null ? String(p.to) : "100");
    setStepStr(p.step != null ? String(p.step) : "1");
    setFpsStr(p.fps != null ? String(p.fps) : "12");
    setLoop(p.loop === true);
  }, [isOpen, editingId, data]);

  // Auto-select the first chart / param when switching to the chart-param type.
  useEffect(() => {
    if (driverType !== "chartParam") return;
    if (!chartId && charts.length) setChartId(charts[0].chartId);
  }, [driverType, charts, chartId]);
  useEffect(() => {
    if (driverType !== "chartParam") return;
    if (params.length && !params.some((p) => p.name === paramName)) setParamName(params[0].name);
  }, [driverType, params, paramName]);

  if (!isOpen) return null;

  const handleSave = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    const fps = Number(fpsStr);
    if (!Number.isFinite(fps)) {
      setError("fps must be a number");
      return;
    }
    const playback = { fps: Math.max(1, Math.min(120, Math.round(fps))), loop };
    const existing = editingId ? getAnimation(editingId) : undefined;

    let spec: AnimationSpec;
    if (driverType === "clockCell") {
      const parsed = parseA1(cellRef);
      if (!parsed) {
        setError("Driver cell must be like B1");
        return;
      }
      const from = Number(fromStr);
      const to = Number(toStr);
      const step = Number(stepStr);
      if (![from, to, step].every(Number.isFinite) || step === 0) {
        setError("From / To / Step must be numbers and Step ≠ 0");
        return;
      }
      const sheetIndex = existing ? existing.sheetIndex : await getActiveSheet();
      spec = {
        id: editingId ?? newAnimationId(),
        name: trimmed,
        sheetIndex,
        driver: "clockCell",
        playback,
        clockCell: { row: parsed.row, col: parsed.col, from, to, step },
      };
    } else {
      if (!chartId || !selectedParam) {
        setError("Pick a chart and a bindable param");
        return;
      }
      const sequence = deriveSequence(selectedParam.bind);
      if (!sequence) {
        setError("This param has no bindable range to animate");
        return;
      }
      const chart = charts.find((c) => c.chartId === chartId);
      const sheetIndex = chart ? chart.sheetIndex : existing ? existing.sheetIndex : await getActiveSheet();
      spec = {
        id: editingId ?? newAnimationId(),
        name: trimmed,
        sheetIndex,
        driver: "chartParam",
        playback,
        chartParam: { chartId, paramName: selectedParam.name, sequence },
      };
    }

    await upsertAnimation(spec);
    await playbackEngine.loadSpec(spec);
    onClose();
  };

  return (
    <div style={backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={dialog}>
        <div style={header}>
          <span>{editingId ? "Edit animation" : "New animation"}</span>
          <button style={{ ...button, height: 24, padding: "0 8px" }} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={body}>
          <div>
            <div style={labelStyle}>Name</div>
            <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue ramp" />
          </div>

          <div>
            <div style={labelStyle}>Driver type</div>
            <select style={field} value={driverType} onChange={(e) => setDriverType(e.target.value as DriverKind)}>
              <option value="clockCell">Clock cell</option>
              <option value="chartParam">Chart param</option>
            </select>
          </div>

          {driverType === "clockCell" ? (
            <>
              <div>
                <div style={labelStyle}>Driver cell</div>
                <input style={field} value={cellRef} onChange={(e) => setCellRef(e.target.value)} placeholder="B1" />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>From</div>
                  <input style={field} value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>To</div>
                  <input style={field} value={toStr} onChange={(e) => setToStr(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>Step</div>
                  <input style={field} value={stepStr} onChange={(e) => setStepStr(e.target.value)} />
                </div>
              </div>
            </>
          ) : charts.length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 11 }}>
              No charts with bindable params. Add a param with a stepper / cycle / segment bind to a chart first.
            </div>
          ) : (
            <>
              <div>
                <div style={labelStyle}>Chart</div>
                <select style={field} value={chartId} onChange={(e) => setChartId(e.target.value)}>
                  {charts.map((c) => (
                    <option key={c.chartId} value={c.chartId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div style={labelStyle}>Param</div>
                <select
                  style={field}
                  value={paramName}
                  onChange={(e) => setParamName(e.target.value)}
                  disabled={params.length === 0}
                >
                  {params.length === 0 ? (
                    <option value="">— no bindable params —</option>
                  ) : (
                    params.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div style={{ opacity: 0.75, fontSize: 11 }}>{sequencePreview(derivedSeq)}</div>
            </>
          )}

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div>
              <div style={labelStyle}>fps</div>
              <input
                style={{ ...field, width: 70 }}
                type="number"
                min={1}
                max={120}
                value={fpsStr}
                onChange={(e) => setFpsStr(e.target.value)}
              />
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 14 }}>
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              loop
            </label>
          </div>
          {error && <div style={{ color: "var(--error-color, #c0392b)", fontSize: 11 }}>{error}</div>}
        </div>
        <div style={footer}>
          <button style={button} onClick={onClose}>
            Cancel
          </button>
          <button style={primary} onClick={() => void handleSave()}>
            {editingId ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
