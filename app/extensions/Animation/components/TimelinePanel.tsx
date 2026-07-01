//! FILENAME: app/extensions/Animation/components/TimelinePanel.tsx
// PURPOSE: The Animation timeline panel — saved animations (load/edit/delete/new),
//          an ad-hoc driver quick-config, and the playback transport (play/pause/
//          stop/step, scrubber, fps, loop). A pure view over the playbackEngine
//          and animationStore.
import React, { useCallback, useEffect, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { getActiveSheet } from "@api/lib";
import { showDialog } from "@api/ui";
import { ExtensionRegistry } from "@api";
import type { Selection } from "@api";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { listAnimations, subscribeAnimations, deleteAnimation } from "../lib/animationStore";
import { exportAnimationGif } from "../lib/gifExporter";
import { exportAnimationWebm, isWebmRecordingSupported } from "../lib/webmExporter";
import { mcActive } from "../lib/monteCarloStore";
import { MonteCarloView } from "./MonteCarloView";
import type { AnimationSpec } from "../types";
import { parseA1 } from "../lib/a1";
import { ANIMATION_DIALOG_ID } from "./AnimationDialog";
import { PlayIcon, PauseIcon, StopIcon, StepBackIcon, StepFwdIcon } from "./icons";

const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 28,
  height: 26,
  padding: "0 6px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
  background: "var(--button-bg, #fff)",
  cursor: "pointer",
};
const smallBtn: React.CSSProperties = { ...btn, minWidth: 0, height: 22, padding: "0 6px", fontSize: 11 };
const field: React.CSSProperties = {
  width: "100%",
  height: 24,
  boxSizing: "border-box",
  padding: "0 6px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
};
const label: React.CSSProperties = { fontSize: 11, opacity: 0.75, marginBottom: 2 };
const sectionTitle: React.CSSProperties = { fontSize: 11, fontWeight: 600, opacity: 0.7, textTransform: "uppercase" };

export function TimelinePanel({ placement }: PanelSectionProps): React.ReactElement {
  const [state, setState] = useState<EngineState>(() => playbackEngine.getState());
  useEffect(() => playbackEngine.subscribe(setState), []);

  const [specs, setSpecs] = useState<AnimationSpec[]>(() => listAnimations());
  useEffect(() => {
    const refresh = () => setSpecs(listAnimations());
    refresh();
    return subscribeAnimations(refresh);
  }, []);

  const [cellRef, setCellRef] = useState("B1");
  const [fromStr, setFromStr] = useState("0");
  const [toStr, setToStr] = useState("100");
  const [stepStr, setStepStr] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => ExtensionRegistry.onSelectionChange(setSelection), []);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const hasDriver = state.frameCount > 0;
  const isPlaying = state.status === "playing";

  const handleExport = useCallback(async () => {
    const src = playbackEngine.getExportSource();
    if (!src) return;
    setExportMsg(null);
    if (src.kind === "grid" && !selection) {
      setExportMsg("Select a range to export first.");
      return;
    }
    setExporting(true);
    const result =
      src.kind === "chart"
        ? await exportAnimationGif({ kind: "chart", chartId: src.chartId }, "chart-animation")
        : await exportAnimationGif(
            {
              kind: "selection",
              range: {
                startRow: Math.min(selection!.startRow, selection!.endRow),
                startCol: Math.min(selection!.startCol, selection!.endCol),
                endRow: Math.max(selection!.startRow, selection!.endRow),
                endCol: Math.max(selection!.startCol, selection!.endCol),
              },
            },
            "grid-animation",
          );
    setExporting(false);
    setExportMsg(
      result.ok
        ? `Saved ${result.path}`
        : result.error === "cancelled"
          ? null
          : `Export failed: ${result.error}`,
    );
  }, [selection]);

  const handleExportWebm = useCallback(async () => {
    setExportMsg(null);
    setExporting(true);
    const result = await exportAnimationWebm("animation");
    setExporting(false);
    setExportMsg(
      result.ok
        ? `Saved ${result.path}`
        : result.error === "cancelled"
          ? null
          : `Export failed: ${result.error}`,
    );
  }, []);

  const webmSupported = isWebmRecordingSupported();

  const handleSetDriver = useCallback(async () => {
    const parsed = parseA1(cellRef);
    if (!parsed) {
      setFormError("Enter a driver cell like B1");
      return;
    }
    const from = Number(fromStr);
    const to = Number(toStr);
    const step = Number(stepStr);
    if (![from, to, step].every(Number.isFinite) || step === 0) {
      setFormError("From / To / Step must be numbers and Step ≠ 0");
      return;
    }
    setFormError(null);
    const sheetIndex = await getActiveSheet();
    await playbackEngine.setClockCellDriver({ sheetIndex, row: parsed.row, col: parsed.col, from, to, step });
  }, [cellRef, fromStr, toStr, stepStr]);

  const openSaveCurrent = useCallback(() => {
    showDialog(ANIMATION_DIALOG_ID, {
      prefill: { cellRef, from: fromStr, to: toStr, step: stepStr, fps: state.fps, loop: state.loop },
    });
  }, [cellRef, fromStr, toStr, stepStr, state.fps, state.loop]);

  const horizontal = placement === "ribbon";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: 12,
        padding: 8,
        fontSize: 12,
        alignItems: horizontal ? "flex-start" : "stretch",
      }}
    >
      {/* Saved animations */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={sectionTitle}>Saved animations</span>
          <button style={smallBtn} onClick={() => showDialog(ANIMATION_DIALOG_ID, {})}>
            + New
          </button>
        </div>
        {specs.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 11 }}>None yet — configure a driver below and Save, or click New.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {specs.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>
                  {s.name}
                </span>
                <button style={smallBtn} title="Load" onClick={() => void playbackEngine.loadSpec(s)}>
                  Load
                </button>
                <button style={smallBtn} title="Edit" onClick={() => showDialog(ANIMATION_DIALOG_ID, { editingId: s.id })}>
                  Edit
                </button>
                <button style={smallBtn} title="Delete" onClick={() => void deleteAnimation(s.id)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ad-hoc driver quick-config */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
        <span style={sectionTitle}>Quick driver</span>
        <div>
          <div style={label}>Driver cell</div>
          <input
            style={field}
            data-testid="anim-driver-cell"
            value={cellRef}
            onChange={(e) => setCellRef(e.target.value)}
            placeholder="B1"
          />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ flex: 1 }}>
            <div style={label}>From</div>
            <input style={field} data-testid="anim-from" value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={label}>To</div>
            <input style={field} data-testid="anim-to" value={toStr} onChange={(e) => setToStr(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={label}>Step</div>
            <input style={field} data-testid="anim-step" value={stepStr} onChange={(e) => setStepStr(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={{ ...btn, flex: 1 }} data-testid="anim-set-driver" onClick={() => void handleSetDriver()}>
            Set driver
          </button>
          <button style={btn} title="Save as a named animation" onClick={openSaveCurrent}>
            Save…
          </button>
        </div>
        {formError && <div style={{ color: "var(--error-color, #c0392b)", fontSize: 11 }}>{formError}</div>}
      </div>

      {/* Transport */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 200 }}>
        <span style={sectionTitle}>Playback</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button style={btn} title="Step back" disabled={!hasDriver} onClick={() => void playbackEngine.step(-1)}>
            <StepBackIcon />
          </button>
          <button
            style={btn}
            title={isPlaying ? "Pause" : "Play"}
            disabled={!hasDriver}
            onClick={() => (isPlaying ? playbackEngine.pause() : playbackEngine.play())}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button style={btn} title="Stop (reset)" disabled={!hasDriver} onClick={() => void playbackEngine.stop()}>
            <StopIcon />
          </button>
          <button style={btn} title="Step forward" disabled={!hasDriver} onClick={() => void playbackEngine.step(1)}>
            <StepFwdIcon />
          </button>
          <div style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", opacity: 0.85 }} data-testid="anim-frame">
            {hasDriver ? `${state.frame + 1} / ${state.frameCount}` : "no driver"}
          </div>
        </div>

        <input
          type="range"
          min={state.rangeStart}
          max={state.rangeEnd}
          value={state.frame}
          step={1}
          disabled={!hasDriver}
          onChange={(e) => void playbackEngine.seek(Number(e.target.value))}
          style={{ width: "100%" }}
        />

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>
            value: <strong>{state.frameLabel ?? "—"}</strong>
          </div>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            fps
            <input
              type="number"
              min={1}
              max={120}
              value={state.fps}
              onChange={(e) => playbackEngine.setFps(Number(e.target.value))}
              style={{ ...field, width: 56 }}
            />
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={state.loop} onChange={(e) => playbackEngine.setLoop(e.target.checked)} />
            loop
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={btn} disabled={!hasDriver || exporting} onClick={() => void handleExport()}>
            {exporting ? "Exporting…" : "Export GIF"}
          </button>
          <button
            style={btn}
            disabled={!hasDriver || exporting || !webmSupported}
            title={webmSupported ? "Record live playback to WebM video" : "Video recording is not available in this runtime"}
            onClick={() => void handleExportWebm()}
          >
            Export WebM
          </button>
          {exportMsg && (
            <span
              style={{ fontSize: 11, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={exportMsg}
            >
              {exportMsg}
            </span>
          )}
        </div>
      </div>

      {mcActive() && <MonteCarloView />}
    </div>
  );
}
