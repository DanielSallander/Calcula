//! FILENAME: app/extensions/Animation/components/TimelineSections.tsx
// PURPOSE: The Animation panel's four sections — saved animations, quick
//          driver config, playback transport, export. Pure views over the
//          playbackEngine and animationStore.
// CONTEXT: Composed from @api/layout primitives, so the same components render
//          vertically in the sidebar and horizontally in the ribbon band; the
//          unbounded saved-animations list and the Monte Carlo histogram
//          demote to launcher flyouts in the band (ItemList/Tall). This is the
//          reference DUAL-SURFACE panel (sidebar by default, freely movable).
//
//          Every section's band content obeys the fill rule (@api/layout
//          tokens.ts): ONE TALL ROW of 61px (the saved-list launcher, the two
//          export heroes) or TWO ROWS of 28 + 5 + 28 (driver fields over
//          driver actions; transport over scrubber). The transport is the one
//          section whose two surfaces differ in shape: the sidebar gives the
//          scrubber a row of its own, which would be a forbidden third row in
//          the band, so there the scrubber shares a row with the readouts.
//
//          E2E contract: the transport buttons keep their `title` attributes
//          exactly ("Play"/"Pause", "Step back", "Stop (reset)", "Step
//          forward") because the journeys select them by title; they pass
//          tooltip={false} so the native title is the only hover text.

import React, { useCallback, useEffect, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { getActiveSheet } from "@api/lib";
import { showDialog } from "@api/ui";
import { ExtensionRegistry } from "@api";
import type { Selection } from "@api";
import {
  ActionRow,
  Button,
  Chip,
  CommandButton,
  ControlRow,
  Field,
  FieldGrid,
  GAP_SM,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_MD,
  ICON_SIZE_SM,
  IconButton,
  Input,
  ItemList,
  LT,
  NumberField,
  ROW_GAP,
  Segmented,
  Slider,
  Stack,
  StatusText,
  Tall,
  useSurfaceLayout,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { listAnimations, subscribeAnimations, deleteAnimation } from "../lib/animationStore";
import { exportAnimationGif } from "../lib/gifExporter";
import { exportAnimationWebm, isWebmRecordingSupported } from "../lib/webmExporter";
import { mcActive } from "../lib/monteCarloStore";
import { MonteCarloView } from "./MonteCarloView";
import type { AnimationSpec } from "../types";
import { parseA1 } from "../lib/a1";
import { ANIMATION_DIALOG_ID } from "./AnimationDialog";

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
      icon={<RibbonIcon.Folder size={ICON_SIZE_MD} />}
      testId="anim-saved-list"
    >
      <ActionRow>
        <Button
          size="sm"
          icon={<RibbonIcon.Plus size={16} />}
          data-testid="anim-new"
          onClick={() => showDialog(ANIMATION_DIALOG_ID, {})}
        >
          New
        </Button>
      </ActionRow>
      {specs.length === 0 ? (
        <div style={{ color: LT.textSecondary, fontSize: 11, lineHeight: "16px" }}>
          None yet — configure a driver and Save, or click New.
        </div>
      ) : (
        specs.map((s) => (
          <div
            key={s.id}
            style={{ display: "flex", alignItems: "center", gap: GAP_SM, fontSize: 12, color: LT.text }}
          >
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
            <IconButton
              size="sm"
              icon={<RibbonIcon.Close size={16} />}
              label="Delete"
              data-testid={`anim-delete-${s.id}`}
              onClick={() => void deleteAnimation(s.id)}
            />
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

  // Band: fields over actions = 28 + 5 + 28. A validation message is a third
  // child, which the band Stack wraps into a column beside them.
  return (
    <Stack gap={ROW_GAP}>
      <FieldGrid>
        <Field label="Driver cell">
          <Input
            data-testid="anim-driver-cell"
            value={cellRef}
            onChange={(e) => setCellRef(e.target.value)}
            placeholder="B1"
          />
        </Field>
        <div style={{ display: "flex", gap: GAP_SM, minWidth: 0 }}>
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
          <span style={{ color: LT.dangerFg }} data-testid="anim-driver-error">
            {formError}
          </span>
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
  const layout = useSurfaceLayout();
  const band = layout.container === "band";
  const hasDriver = state.frameCount > 0;
  const isPlaying = state.status === "playing";

  const transport = (
    <Segmented ariaLabel="Playback">
      <IconButton
        icon={<RibbonIcon.StepBack size={ICON_SIZE_SM} />}
        label="Step back"
        title="Step back"
        tooltip={false}
        disabled={!hasDriver}
        onClick={() => void playbackEngine.step(-1)}
      />
      <IconButton
        icon={isPlaying ? <RibbonIcon.Pause size={ICON_SIZE_SM} /> : <RibbonIcon.Play size={ICON_SIZE_SM} />}
        label={isPlaying ? "Pause" : "Play"}
        title={isPlaying ? "Pause" : "Play"}
        tooltip={false}
        disabled={!hasDriver}
        onClick={() => (isPlaying ? playbackEngine.pause() : playbackEngine.play())}
      />
      <IconButton
        icon={<RibbonIcon.Stop size={ICON_SIZE_SM} />}
        label="Stop (reset)"
        title="Stop (reset)"
        tooltip={false}
        disabled={!hasDriver}
        onClick={() => void playbackEngine.stop()}
      />
      <IconButton
        icon={<RibbonIcon.StepForward size={ICON_SIZE_SM} />}
        label="Step forward"
        title="Step forward"
        tooltip={false}
        disabled={!hasDriver}
        onClick={() => void playbackEngine.step(1)}
      />
    </Segmented>
  );

  /*
    UNLOAD — the product's route out of owning a driver, and the second half of
    D4. "Stop" restores the model but keeps the driver loaded (correct: a user
    mid-iteration wants to press Play again), so before this button there was
    no way to give the driver back at all and the play pill stayed until the
    page reloaded. Deliberately separate from Stop rather than folded into it,
    for that same reason — and outside the transport pill, for the same reason.
  */
  const unload = (
    <IconButton
      icon={<RibbonIcon.Upload size={ICON_SIZE_SM} />}
      label="Unload driver"
      title="Unload driver (restores the model and hides the play pill)"
      tooltip={false}
      data-testid="anim-clear-driver"
      disabled={!hasDriver}
      onClick={() => void playbackEngine.clearDriver()}
    />
  );

  const frameReadout = (
    <div
      style={{
        marginLeft: band ? undefined : "auto",
        fontVariantNumeric: "tabular-nums",
        color: LT.text,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
      data-testid="anim-frame"
    >
      {hasDriver ? `${state.frame + 1} / ${state.frameCount}` : "no driver"}
    </div>
  );

  const scrubber = (
    <Slider
      value={state.frame}
      min={state.rangeStart}
      max={state.rangeEnd}
      step={1}
      readout={false}
      ariaLabel="Frame"
      testId="anim-scrubber"
      disabled={!hasDriver}
      onChange={(frame) => void playbackEngine.seek(frame)}
    />
  );

  const valueReadout = (
    <span
      style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, whiteSpace: "nowrap", color: LT.textSecondary }}
    >
      value: <strong style={{ color: LT.text }}>{state.frameLabel ?? "—"}</strong>
    </span>
  );

  const fps = (
    <NumberField
      label="fps"
      value={state.fps}
      min={1}
      max={120}
      width={56}
      testId="anim-fps"
      onChange={(v) => {
        if (v !== null) playbackEngine.setFps(v);
      }}
    />
  );

  const loop = (
    <Chip
      value={state.loop ? "On" : "Off"}
      active={state.loop}
      testId="anim-loop"
      onClick={() => playbackEngine.setLoop(!state.loop)}
    >
      Loop
    </Chip>
  );

  const monteCarlo = mcActive() && (
    <Tall label="Distribution" icon={<RibbonIcon.ChartHistogram size={ICON_SIZE_MD} />} testId="anim-mc-block">
      <MonteCarloView />
    </Tall>
  );

  if (band) {
    // Two rows (28 + 5 + 28); the Monte Carlo launcher, when present, is a
    // 61px control the band Stack wraps into a column of its own.
    return (
      <Stack gap={ROW_GAP}>
        <ControlRow gap={GAP_XS}>
          {transport}
          {unload}
          {frameReadout}
        </ControlRow>
        <ControlRow gap={GAP_SM}>
          {scrubber}
          {valueReadout}
          {fps}
          {loop}
        </ControlRow>
        {monteCarlo}
      </Stack>
    );
  }

  return (
    <Stack gap={GAP_SM}>
      <ControlRow gap={GAP_XS}>
        {transport}
        {unload}
        {frameReadout}
      </ControlRow>
      {scrubber}
      <ControlRow gap={GAP_SM}>
        {valueReadout}
        {fps}
        {loop}
      </ControlRow>
      {monteCarlo}
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

  // Two 61px heroes: one tall row in the band, two 28px buttons in the panel.
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.SaveImage size={HERO_ICON_SIZE} />}
        label={exporting ? "Exporting…" : "Export GIF"}
        data-testid="anim-export-gif"
        disabled={!hasDriver || exporting}
        onClick={() => void handleExport()}
      />
      {/* A native title, not the Tooltip primitive: its main job is to say
          WHY the button is disabled, and a disabled button never receives the
          pointer events the Tooltip opens on. */}
      <CommandButton
        icon={<RibbonIcon.Download size={HERO_ICON_SIZE} />}
        label="Export WebM"
        title={
          webmSupported
            ? "Record live playback to WebM video"
            : "Video recording is not available in this runtime"
        }
        tooltip={false}
        data-testid="anim-export-webm"
        disabled={!hasDriver || exporting || !webmSupported}
        onClick={() => void handleExportWebm()}
      />
      {exportMsg && <StatusText title={exportMsg}>{exportMsg}</StatusText>}
    </ActionRow>
  );
}
