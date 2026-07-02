//! FILENAME: app/extensions/Animation/components/TimelineSections.tsx
// PURPOSE: The Animation panel's four sections — saved animations, quick
//          driver config, playback transport, export. Pure views over the
//          playbackEngine and animationStore.
// CONTEXT: Composed from @api/layout primitives, so the same components render
//          vertically in the sidebar and horizontally in the 92px ribbon band;
//          the unbounded saved-animations list and the Monte Carlo histogram
//          demote to launcher flyouts in the band (ItemList/Tall). Replaces
//          the former monolithic TimelinePanel, which had no ribbon form and
//          forced the panel to be sidebar-locked.

import React, { useCallback, useEffect, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { getActiveSheet } from "@api/lib";
import { showDialog } from "@api/ui";
import { ExtensionRegistry } from "@api";
import type { Selection } from "@api";
import {
  ActionRow,
  Button,
  ControlRow,
  Field,
  FieldGrid,
  Grow,
  Input,
  ItemList,
  Stack,
  StatusText,
  Tall,
} from "@api/layout";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { listAnimations, subscribeAnimations, deleteAnimation } from "../lib/animationStore";
import { exportAnimationGif } from "../lib/gifExporter";
import { exportAnimationWebm, isWebmRecordingSupported } from "../lib/webmExporter";
import { mcActive } from "../lib/monteCarloStore";
import { MonteCarloView } from "./MonteCarloView";
import type { AnimationSpec } from "../types";
import { parseA1 } from "../lib/a1";
import { ANIMATION_DIALOG_ID } from "./AnimationDialog";
import { PlayIcon, PauseIcon, StopIcon, StepBackIcon, StepFwdIcon, FilmIcon } from "./icons";

function useEngineState(): EngineState {
  const [state, setState] = useState<EngineState>(() => playbackEngine.getState());
  useEffect(() => playbackEngine.subscribe(setState), []);
  return state;
}

// ============================================================================
// Saved animations
// ============================================================================

export function SavedAnimationsSection(_props: PanelSectionProps): React.ReactElement {
  const [specs, setSpecs] = useState<AnimationSpec[]>(() => listAnimations());
  useEffect(() => {
    const refresh = () => setSpecs(listAnimations());
    refresh();
    return subscribeAnimations(refresh);
  }, []);

  return (
    <ItemList
      label="Animations"
      count={specs.length}
      icon={<FilmIcon />}
      testId="anim-saved-list"
    >
      <ActionRow>
        <Button size="sm" data-testid="anim-new" onClick={() => showDialog(ANIMATION_DIALOG_ID, {})}>
          + New
        </Button>
      </ActionRow>
      {specs.length === 0 ? (
        <div style={{ opacity: 0.6, fontSize: 11 }}>
          None yet — configure a driver and Save, or click New.
        </div>
      ) : (
        specs.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span
              style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={s.name}
            >
              {s.name}
            </span>
            <Button size="sm" title="Load" onClick={() => void playbackEngine.loadSpec(s)}>
              Load
            </Button>
            <Button size="sm" title="Edit" onClick={() => showDialog(ANIMATION_DIALOG_ID, { editingId: s.id })}>
              Edit
            </Button>
            <Button size="sm" title="Delete" onClick={() => void deleteAnimation(s.id)}>
              ✕
            </Button>
          </div>
        ))
      )}
    </ItemList>
  );
}

// ============================================================================
// Quick driver config
// ============================================================================

export function DriverSection(_props: PanelSectionProps): React.ReactElement {
  const [cellRef, setCellRef] = useState("B1");
  const [fromStr, setFromStr] = useState("0");
  const [toStr, setToStr] = useState("100");
  const [stepStr, setStepStr] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);

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
    const state = playbackEngine.getState();
    showDialog(ANIMATION_DIALOG_ID, {
      prefill: { cellRef, from: fromStr, to: toStr, step: stepStr, fps: state.fps, loop: state.loop },
    });
  }, [cellRef, fromStr, toStr, stepStr]);

  return (
    <Stack gap={6}>
      <FieldGrid>
        <Field label="Driver cell">
          <Input
            data-testid="anim-driver-cell"
            value={cellRef}
            onChange={(e) => setCellRef(e.target.value)}
            placeholder="B1"
          />
        </Field>
        <div style={{ display: "flex", gap: 6, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="From">
              <Input data-testid="anim-from" value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="To">
              <Input data-testid="anim-to" value={toStr} onChange={(e) => setToStr(e.target.value)} />
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="Step">
              <Input data-testid="anim-step" value={stepStr} onChange={(e) => setStepStr(e.target.value)} />
            </Field>
          </div>
        </div>
      </FieldGrid>
      <ActionRow>
        <Button grow data-testid="anim-set-driver" onClick={() => void handleSetDriver()}>
          Set driver
        </Button>
        <Button title="Save as a named animation" onClick={openSaveCurrent}>
          Save…
        </Button>
      </ActionRow>
      {formError && (
        <StatusText title={formError}>
          <span style={{ color: "var(--error-color, #c0392b)" }}>{formError}</span>
        </StatusText>
      )}
    </Stack>
  );
}

// ============================================================================
// Playback transport
// ============================================================================

export function TransportSection(_props: PanelSectionProps): React.ReactElement {
  const state = useEngineState();
  const hasDriver = state.frameCount > 0;
  const isPlaying = state.status === "playing";

  return (
    <Stack gap={4}>
      <ControlRow gap={6}>
        <Button title="Step back" disabled={!hasDriver} onClick={() => void playbackEngine.step(-1)}>
          <StepBackIcon />
        </Button>
        <Button
          title={isPlaying ? "Pause" : "Play"}
          disabled={!hasDriver}
          onClick={() => (isPlaying ? playbackEngine.pause() : playbackEngine.play())}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button title="Stop (reset)" disabled={!hasDriver} onClick={() => void playbackEngine.stop()}>
          <StopIcon />
        </Button>
        <Button title="Step forward" disabled={!hasDriver} onClick={() => void playbackEngine.step(1)}>
          <StepFwdIcon />
        </Button>
        <div
          style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", opacity: 0.85, fontSize: 12, whiteSpace: "nowrap" }}
          data-testid="anim-frame"
        >
          {hasDriver ? `${state.frame + 1} / ${state.frameCount}` : "no driver"}
        </div>
      </ControlRow>

      <ControlRow>
        <Grow>
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
        </Grow>
      </ControlRow>

      <ControlRow gap={10}>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, whiteSpace: "nowrap" }}>
          value: <strong>{state.frameLabel ?? "—"}</strong>
        </span>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
          fps
          <Input
            type="number"
            min={1}
            max={120}
            width={56}
            value={state.fps}
            onChange={(e) => playbackEngine.setFps(Number(e.target.value))}
          />
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={state.loop} onChange={(e) => playbackEngine.setLoop(e.target.checked)} />
          loop
        </label>
      </ControlRow>

      {mcActive() && (
        <Tall label="Distribution" icon={<FilmIcon />} testId="anim-mc-block">
          <MonteCarloView />
        </Tall>
      )}
    </Stack>
  );
}

// ============================================================================
// Export
// ============================================================================

export function ExportSection(_props: PanelSectionProps): React.ReactElement {
  const state = useEngineState();
  const hasDriver = state.frameCount > 0;

  const [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => ExtensionRegistry.onSelectionChange(setSelection), []);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

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

  return (
    <ActionRow>
      <Button disabled={!hasDriver || exporting} onClick={() => void handleExport()}>
        {exporting ? "Exporting…" : "Export GIF"}
      </Button>
      <Button
        disabled={!hasDriver || exporting || !webmSupported}
        title={
          webmSupported
            ? "Record live playback to WebM video"
            : "Video recording is not available in this runtime"
        }
        onClick={() => void handleExportWebm()}
      >
        Export WebM
      </Button>
      {exportMsg && <StatusText title={exportMsg}>{exportMsg}</StatusText>}
    </ActionRow>
  );
}
