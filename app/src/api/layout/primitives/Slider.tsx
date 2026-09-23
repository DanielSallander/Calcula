//! FILENAME: app/src/api/layout/primitives/Slider.tsx
// PURPOSE: The range control of the Calcula Clusters grammar — label, track
//          and a live monospace readout on one 28px row ("Gap ━━●── 150 %").
// CONTEXT: Chart gap width, label size, transparency, animation speed: every
//          one of them was a bare <input type="range"> painted by the OS, whose
//          track ignores the skin and whose value was invisible until you let
//          go. This is the mockup's `.cal-sl`:
//
//          - The track is the input itself (`appearance: none`, 5px tall) and
//            the filled part is an inline linear-gradient computed from the
//            value — LT.stateAccent up to the thumb, LT.controlTrack after it.
//            Chromium has no ::-webkit-slider-progress, and a gradient needs no
//            extra element; both colours are LT tokens, so the fill follows
//            the skin like everything else.
//          - The readout is an <output> in FONT_MONO with tabular figures and
//            a minimum width, so the row does not jitter as digits change.
//            It is aria-hidden: the input carries the same text as
//            `aria-valuetext`, and an <output> is an implicit live region
//            that would otherwise announce every step of a drag.
//
//          onChange vs onCommit. onChange fires on every step, for a live
//          preview. onCommit fires ONCE when an interaction ends — pointerup,
//          or keyup of a key that moves the value — and only when the value
//          actually differs from where that interaction started. That is the
//          place to write the document (one backend write, one undo entry);
//          the ControlsPane slider learned the hard way that a commit per
//          frame floods the undo stack. A blur also ends an interaction, so a
//          release the input never saw (the pointer let go over another
//          window) still commits exactly once.
//
//          Width: 104px track in the band (it must fit a cluster), the rest of
//          the row in a panel. Colours come only from LT (../theme).

import React, { forwardRef, useId, useRef } from "react";
import { css } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { CONTROL_HEIGHT_MD, FONT_FAMILY, FONT_MONO, GAP_MD } from "../tokens";

// ============================================================================
// Pure helpers (exported for tests)
// ============================================================================

/** Default track width in the ribbon band. */
export const SLIDER_BAND_WIDTH = 104;

/** How far along the track `value` sits, as a percentage clamped to 0..100.
 *  A degenerate range (max <= min) reads as empty rather than NaN. */
export function sliderFillPercent(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  const pct = ((value - min) / (max - min)) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Decimal places a step implies: 1 -> 0, 0.05 -> 2, 1e-3 -> 3. */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const [mantissa, exponent] = step.toExponential().split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent));
}

/**
 * The readout text: the value at the precision its step implies (so 0.1 + 0.2
 * never shows as 0.30000000000000004), then the suffix after a space, the way
 * the mockup writes it ("150 %", "10 px").
 */
export function formatSliderValue(value: number, step = 1, suffix?: string): string {
  const decimals = stepDecimals(step);
  const number = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value * 1e9) / 1e9);
  return suffix ? `${number} ${suffix}` : number;
}

/** The inline track background: accent up to the thumb, track after it. */
export function sliderTrackBackground(pct: number): string {
  const p = `${Math.round(pct * 100) / 100}%`;
  return `linear-gradient(to right, ${LT.stateAccent} 0 ${p}, ${LT.controlTrack} ${p} 100%)`;
}

/** Keys that move a range input's value (and so end in a commit). */
const VALUE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

// ============================================================================
// Styles
// ============================================================================

const rowBase = css`
  align-items: center;
  gap: ${GAP_MD}px;
  box-sizing: border-box;
  height: ${CONTROL_HEIGHT_MD}px;
  min-width: 0;
  font-family: ${FONT_FAMILY};

  &[data-disabled="true"] {
    opacity: 0.5;
    cursor: default;
  }
`;

/** Band: an inline row sized by its track. */
const rowBand = css`
  display: inline-flex;
`;

/** Panel/popover: the full row, the track taking what the label leaves. */
const rowPanel = css`
  display: flex;
  width: 100%;
`;

const labelStyle = css`
  flex: none;
  font-size: 12px;
  line-height: 1;
  color: ${LT.textSecondary};
  white-space: nowrap;
`;

/** The thumb recipe, written once for both engines' pseudo-elements. */
const thumb = `
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border: 1px solid ${LT.controlBorder};
  border-radius: 50%;
  background: ${LT.surface};
  box-shadow: ${LT.shadowClusterHover};
  cursor: pointer;
  transition: box-shadow ${LT.motionHover};
`;

const range = css`
  appearance: none;
  box-sizing: border-box;
  height: 5px;
  min-width: 0;
  margin: 0;
  border-radius: 3px;
  cursor: pointer;

  &::-webkit-slider-thumb {
    appearance: none;
    ${thumb}
  }

  &::-moz-range-thumb {
    ${thumb}
  }

  &:focus-visible {
    outline: none;
  }

  &:focus-visible::-webkit-slider-thumb {
    box-shadow: ${LT.focusRing};
  }

  &:focus-visible::-moz-range-thumb {
    box-shadow: ${LT.focusRing};
  }

  &:disabled,
  &:disabled::-webkit-slider-thumb {
    cursor: default;
  }
`;

/** Panel: the track grows unless the caller fixed a width. */
const rangeGrow = css`
  flex: 1 1 auto;
`;

const readoutStyle = css`
  flex: none;
  min-width: 34px;
  font-family: ${FONT_MONO};
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: ${LT.text};
  white-space: nowrap;
`;

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ============================================================================
// Component
// ============================================================================

export interface SliderProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "defaultValue" | "min" | "max" | "step" | "onChange" | "width" | "size"
  > {
  /** Current value (controlled). */
  value: number;
  min: number;
  max: number;
  /** Step between values. Default 1; also sets the readout's precision. */
  step?: number;
  /** Every step of a drag or key press — for a live preview. */
  onChange: (value: number) => void;
  /** Once per interaction, when it ends with a changed value — for the write
   *  that should become one undo entry. */
  onCommit?: (value: number) => void;
  /** Visible 12px label before the track (also names the input). */
  label?: string;
  /** Unit after the readout value ("%", "px"). */
  suffix?: string;
  /** Show the value readout after the track. Default true. */
  readout?: boolean;
  /** Track width in px. Default 104 in the band; fills the row elsewhere. */
  width?: number;
  /** Accessible name when there is no visible label (wins over `label`). */
  ariaLabel?: string;
  /** data-testid for the <input type="range">. */
  testId?: string;
}

/**
 * A labelled range with a live readout. HTML props (id, name, aria-*,
 * handlers) and the forwarded ref go to the <input>; `className` and `style`
 * go to the row.
 */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    min,
    max,
    step = 1,
    onChange,
    onCommit,
    label,
    suffix,
    readout = true,
    width,
    ariaLabel,
    testId,
    disabled,
    className,
    style,
    ...rest
  },
  ref,
) {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";
  const generatedId = useId();
  const inputId = rest.id ?? generatedId;

  // The value an interaction STARTED from; null while none is in progress.
  const startedFrom = useRef<number | null>(null);

  const begin = (el: HTMLInputElement): void => {
    if (startedFrom.current === null) startedFrom.current = Number(el.value);
  };

  const finish = (el: HTMLInputElement): void => {
    const from = startedFrom.current;
    startedFrom.current = null;
    if (from === null || !onCommit) return;
    const next = Number(el.value);
    if (next !== from) onCommit(next);
  };

  const text = formatSliderValue(value, step, suffix);
  const trackWidth = width ?? (band ? SLIDER_BAND_WIDTH : undefined);

  return (
    <div
      className={classNames(rowBase, band ? rowBand : rowPanel, className)}
      style={style}
      data-disabled={disabled ? "true" : undefined}
    >
      {label && (
        <label htmlFor={inputId} className={labelStyle}>
          {label}
        </label>
      )}
      <input
        data-testid={testId}
        {...rest}
        ref={ref}
        id={inputId}
        type="range"
        className={classNames(range, trackWidth === undefined && rangeGrow)}
        style={{
          width: trackWidth,
          background: sliderTrackBackground(sliderFillPercent(value, min, max)),
        }}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel ?? rest["aria-label"]}
        aria-valuetext={rest["aria-valuetext"] ?? text}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={(e) => {
          rest.onPointerDown?.(e);
          begin(e.currentTarget);
        }}
        onPointerUp={(e) => {
          rest.onPointerUp?.(e);
          finish(e.currentTarget);
        }}
        onPointerCancel={(e) => {
          rest.onPointerCancel?.(e);
          finish(e.currentTarget);
        }}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          if (VALUE_KEYS.has(e.key)) begin(e.currentTarget);
        }}
        onKeyUp={(e) => {
          rest.onKeyUp?.(e);
          if (VALUE_KEYS.has(e.key)) finish(e.currentTarget);
        }}
        onBlur={(e) => {
          rest.onBlur?.(e);
          finish(e.currentTarget);
        }}
      />
      {readout && (
        <output htmlFor={inputId} className={readoutStyle} aria-hidden>
          {text}
        </output>
      )}
    </div>
  );
});
