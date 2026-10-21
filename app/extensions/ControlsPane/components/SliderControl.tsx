//! FILENAME: app/extensions/ControlsPane/components/SliderControl.tsx
// PURPOSE: Numeric slider body for a pane control card. Dragging previews the
//          value locally (transient, no backend/undo/recalc per frame); the
//          value commits once on release — one backend write, one undo entry,
//          one GET.CONTROLVALUE dependent recalc (design decision D5). The
//          commit decision compares against a baseline snapshotted when the
//          interaction began (frozen mid-drag, advanced on commit), so preview
//          re-renders can never swallow the release commit, and duplicate end
//          events (pointerup then blur) commit exactly once.
// CONTEXT: Rendered inside ControlCard; adapts to the ribbon band (compact,
//          fixed-width track) vs sidebar (full-width track) via
//          useSurfaceLayout, like the other Controls-pane cards.
//
//          Drawn by the @api Slider (token track, accent fill, monospace
//          readout), which replaced a bare OS-painted <input type="range">
//          that stayed light in Dark. The COMMIT logic stays here, not in the
//          primitive's onCommit: this control freezes its prop resync for the
//          whole interaction and advances its baseline when a commit is
//          issued, so a slow backend round-trip can never make a second drag
//          commit against a stale start value. The primitive chains the
//          pointer/key/blur handlers below through to its <input>, so they run
//          exactly as they did on the bare input.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Slider, useSurfaceLayout } from "@api/layout";
import { setChartParamValue } from "@api/chartParams";
import { formatNumber } from "@api/locale";
import type { ControlValue } from "@api/controlValues";
import type { PaneControl } from "../lib/controlsPaneTypes";
import { commitValue, previewValue } from "../lib/controlsPaneStore";

type SliderConfig = Extract<PaneControl["config"], { type: "slider" }>;

const FALLBACK_CONFIG: SliderConfig = {
  type: "slider",
  min: 0,
  max: 100,
  step: 1,
  showValue: true,
};

/** Keys that move a range input's thumb — a keyup on these commits. */
const COMMIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface Props {
  control: PaneControl;
}

export function SliderControl({ control }: Props): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  const config: SliderConfig =
    control.config.type === "slider" ? control.config : FALLBACK_CONFIG;

  const committedValue =
    control.value?.kind === "number" ? control.value.value : config.min;

  // Displayed value: tracks the thumb mid-drag, the committed value otherwise.
  const [localValue, setLocalValue] = useState<number>(committedValue);

  // True from the first pointerdown / thumb-moving keydown / change frame of
  // an interaction until its end event (pointerup / keyup / blur) runs.
  const interactingRef = useRef(false);

  // Commit baseline: the committed value as of when the current interaction
  // BEGAN. Synced from props only while idle (never mid-drag — preview
  // re-renders must not move it) and advanced when a commit is issued. The
  // end-of-interaction comparison against it decides whether to commit and
  // guards duplicate end events (pointerup then blur) down to ONE commit.
  const baselineRef = useRef<number>(committedValue);

  // Commits currently awaiting the backend (commitValue never rejects).
  const pendingCommitsRef = useRef(0);

  // Resync display + baseline when the value changes externally (undo/redo
  // refresh, script, load) — but never mid-interaction: the thumb keeps the
  // user's drag value and the baseline keeps its interaction-start snapshot.
  useEffect(() => {
    if (interactingRef.current) return;
    setLocalValue(committedValue); // eslint-disable-line react-hooks/set-state-in-effect -- prop->display sync must skip mid-drag (ref guard), which defeats the rule's plain-sync exemption
    baselineRef.current = committedValue;
  }, [committedValue]);

  // Interaction start: freeze the baseline and the prop-resync until the
  // matching end event. The baseline itself is NOT rewritten here — while
  // idle it already equals the last committed value, and during rapid
  // successive drags it stays ahead of a still-in-flight commit's prop.
  const beginInteraction = useCallback(() => {
    interactingRef.current = true;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (COMMIT_KEYS.has(e.key)) beginInteraction();
    },
    [beginInteraction],
  );

  // Optional chart-param binding (D9/Phase 7): drive the bound chart param on
  // every value change INCLUDING transient drag frames — the widget value is
  // frontend-ephemeral (chartParams facade), so live-animating the chart
  // mid-drag costs no backend writes.
  const chartTarget = config.chartParamTarget;
  const driveChartParam = useCallback(
    (v: number) => {
      if (chartTarget) setChartParamValue(chartTarget.chartId, chartTarget.param, v);
    },
    [chartTarget],
  );

  // Drag frames: local state + transient store event only — no backend, no
  // undo, no recalc, and the store cache stays on the committed value.
  const handleInput = useCallback(
    (v: number) => {
      if (Number.isNaN(v)) return;
      // Safety net: a change without a seen pointerdown/keydown still counts
      // as an interaction (the baseline was prop-synced while idle).
      interactingRef.current = true;
      setLocalValue(v);
      const preview: ControlValue = { kind: "number", value: v };
      previewValue(control.id, preview);
      driveChartParam(v);
    },
    [control.id, driveChartParam],
  );

  // Interaction end: exactly one commit (backend + undo entry + dependent
  // recalc) when the thumb moved; duplicate end events no-op against the
  // advanced baseline. Closes over committedValue (re-bound every render) so
  // the no-commit branch can resync a display frozen during the interaction.
  const commit = useCallback(
    (v: number) => {
      interactingRef.current = false;
      if (Number.isNaN(v)) return;
      if (v === baselineRef.current) {
        // Nothing to commit. If the committed value moved externally mid-drag
        // (the resync effect was frozen), snap the display back to it — but
        // only when no commit is in flight (its prop update hasn't landed).
        if (pendingCommitsRef.current === 0) {
          setLocalValue(committedValue);
          baselineRef.current = committedValue;
        }
        return;
      }
      baselineRef.current = v;
      const committed: ControlValue = { kind: "number", value: v };
      pendingCommitsRef.current += 1;
      void commitValue(control.id, committed).finally(() => {
        pendingCommitsRef.current -= 1;
      });
    },
    [control.id, committedValue],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      commit(rangeValue(e.currentTarget));
    },
    [commit],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (COMMIT_KEYS.has(e.key)) commit(rangeValue(e.currentTarget));
    },
    [commit],
  );

  // Safety net: if focus leaves mid-preview (e.g. pointerup was swallowed),
  // commit whatever the input holds. No-op when nothing changed.
  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      commit(rangeValue(e.target));
    },
    [commit],
  );

  return (
    <Slider
      min={config.min}
      max={config.max}
      step={config.step}
      value={localValue}
      onChange={handleInput}
      onPointerDown={beginInteraction}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      readout={config.showValue}
      // The card is the width: the track takes what the readout leaves.
      width={band ? BAND_TRACK_WIDTH : undefined}
      ariaLabel={control.name}
      title={`${control.name}: ${formatSliderControlValue(localValue, config.step)}`}
      style={styles.row}
    />
  );
}

/** Band track width: fills a card at its minimum width beside the readout. */
const BAND_TRACK_WIDTH = 96;

/**
 * The range input's position as a NUMBER. A range's value is the browser's
 * invariant wire text ("1.5" in every locale), so it is read as the typed
 * `valueAsNumber`, never through a text parser -- the app-locale reader would
 * refuse "1.5" under de-DE, and the old `Number(raw)` was a text parse of it.
 */
function rangeValue(el: HTMLInputElement): number {
  return el.valueAsNumber;
}

/**
 * The title's value: the step's precision (no float noise), in the APP
 * locale ("1,5" under de-DE). The readout beside the track is the @api Slider's
 * own, which formats the same way.
 */
export function formatSliderControlValue(value: number, step: number): string {
  const stepText = String(step);
  const dotIdx = stepText.indexOf(".");
  if (dotIdx === -1) return formatNumber(value);
  const decimals = stepText.length - dotIdx - 1;
  return formatNumber(value, { decimals });
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    minWidth: 0,
  },
};
