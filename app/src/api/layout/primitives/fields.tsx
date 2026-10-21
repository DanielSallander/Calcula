//! FILENAME: app/src/api/layout/primitives/fields.tsx
// PURPOSE: Form primitives: Field (the transposition workhorse), FieldGrid,
//          and NumberField (a number input that can be blank).
// CONTEXT: A labelled field is label-above in the sidebar but label-inline-left
//          in the ribbon band. That single flip is what makes labelled forms
//          viable in the band: inline, a Field is exactly one FIELD_HEIGHT
//          (28px) row, so two of them stack into a cluster's 61px content box
//          as 28 + ROW_GAP 5 + 28 — the fill rule in ../tokens.ts. Label-above
//          in the band would be 13 + 5 + 28 = 46px for ONE field.
//
//          Field's layout stays in inline styles (flex-direction is what the
//          surface decides, and tests read it straight off the element); its
//          label typography is a class, painted with LT.textSecondary rather
//          than the old `opacity: .75`, which also faded the label's
//          focus/selection colours and read differently on every skin.
//
//          NumberField exists because "blank" is a real value in Calcula's
//          forms — an axis minimum left empty means AUTO — and a bare
//          <input type="number"> cannot express it: the browser reports "" both
//          for an empty box and for a half-typed "1." or "-", so a naive
//          `Number(e.target.value)` turned the first keystroke of "-5" into
//          "auto" and applied it to the chart. See the component for how the
//          draft text is kept apart from the committed number.
//
//          P2 (app locale everywhere): the box is a TEXT input that reads and
//          shows numbers in the APP locale ("1,5" under de-DE), never the
//          browser's own locale, which is what a native number input follows
//          and which need not be the app's. NumberInput is the bare <input>
//          with those semantics (draft, app-locale parse, ArrowUp/ArrowDown
//          step, clamp on blur) for callers that style their own box;
//          NumberField puts it on the field chrome.

import React, { forwardRef, useId, useState } from "react";
import { css, cx } from "@emotion/css";
import { formatNumberIn, getActiveLocale, parseNumberIn } from "../../../core/lib/locale";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { FIELD_HEIGHT, FONT_FAMILY, GAP_SM, GAP_XS, LABEL_FONT_SIZE, ROW_GAP } from "../tokens";
import { DISABLED_LOOK } from "./disabled";

// ============================================================================
// Shared styles
// ============================================================================

/** A field's caption: 11px secondary text, never wrapping. */
const fieldLabel = css`
  font-family: ${FONT_FAMILY};
  font-size: ${LABEL_FONT_SIZE}px;
  font-weight: 400;
  line-height: 13px;
  color: ${LT.textSecondary};
  white-space: nowrap;
`;

/**
 * The text-entry chrome Input, Select and NumberField share: a FIELD_HEIGHT
 * box with the control border on the input background, the focus ring plus an
 * accent border on keyboard/typing focus, and the one disabled idiom.
 */
export const fieldChrome = css`
  box-sizing: border-box;
  height: ${FIELD_HEIGHT}px;
  min-width: 0;
  margin: 0;
  border: 1px solid ${LT.controlBorder};
  border-radius: ${LT.radiusControl};
  background: ${LT.inputBg};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  transition:
    border-color ${LT.motionHover},
    box-shadow ${LT.motionHover};

  &::placeholder {
    color: ${LT.textTertiary};
    opacity: 1;
  }

  &:hover:not(:disabled):not(:focus-visible) {
    border-color: ${LT.textTertiary};
  }

  &:focus-visible {
    outline: none;
    border-color: ${LT.stateAccent};
    box-shadow: ${LT.focusRing};
  }

  &:disabled {
    ${DISABLED_LOOK}
  }
`;

// ============================================================================
// Field
// ============================================================================

export interface FieldProps {
  label: string;
  /** Forwarded to the label element for a11y when the control has an id. */
  htmlFor?: string;
  children: React.ReactNode;
}

/**
 * A labeled control. Panel/popover: label above the control.
 * Band: label inline-left of the control on one FIELD_HEIGHT (28px) row.
 */
export function Field({ label, htmlFor, children }: FieldProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: GAP_XS,
          height: FIELD_HEIGHT,
          minWidth: 0,
        }}
      >
        <label htmlFor={htmlFor} className={fieldLabel}>
          {label}
        </label>
        {/* A flex box, not a block: an inline-level control (input, the
            Select's wrapper) in a block gets a line box whose descender strut
            makes the row ~3px taller than the control and pushes it off
            centre. */}
        <div style={{ display: "flex", alignItems: "center", minWidth: 0, flex: 1 }}>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP, minWidth: 0 }}>
      <label htmlFor={htmlFor} className={fieldLabel}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ============================================================================
// FieldGrid
// ============================================================================

export interface FieldGridProps {
  /** Sidebar width (px) above which fields arrange in two columns. */
  twoColumnMinWidth?: number;
  children: React.ReactNode;
}

/**
 * A group of Fields. Band: one inline FIELD_HEIGHT row of narrow labeled
 * inputs (`Cell [B1] From [0] To [10] Step [1]`). Panel: label-above fields
 * stacked, switching to a 2-column grid when the panel is wide enough.
 */
export function FieldGrid({
  twoColumnMinWidth = 260,
  children,
}: FieldGridProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: GAP_SM,
          minHeight: FIELD_HEIGHT,
          minWidth: 0,
        }}
      >
        {children}
      </div>
    );
  }

  const twoCol = layout.width >= twoColumnMinWidth;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: twoCol ? "1fr 1fr" : "1fr",
        gap: GAP_SM,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// NumberInput / NumberField
// ============================================================================

/** Default NumberField width: four digits and a sign at 12px. */
export const NUMBER_FIELD_WIDTH = 62;

/** Significant digits a double round-trips exactly. */
const ROUND_TRIP_DIGITS = 15;

/** Display text for a committed number, in the APP locale: blank for null,
 *  no grouping (so the text reads back exactly), and without binary float
 *  noise (0.1 + 0.2 shows "0.3", not "0.30000000000000004"): fifteen
 *  significant digits, the most a double round-trips exactly. */
export function formatNumberFieldValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  const intDigits = abs >= 1 ? Math.floor(Math.log10(abs)) + 1 : 0;
  const maxDecimals = Math.max(0, Math.min(ROUND_TRIP_DIGITS, ROUND_TRIP_DIGITS - intDigits));
  return formatNumberIn(getActiveLocale(), value, { minDecimals: 0, maxDecimals, grouping: false });
}

/**
 * What the box's text means, read STRICTLY in the app locale: `null` for
 * blank, a number, or `undefined` for text that is not (yet) a number and must
 * not be reported -- a half-typed "-" or "1e", or the foreign spelling ("1.5"
 * under de-DE, where "." groups thousands).
 */
export function parseNumberFieldText(raw: string): number | null | undefined {
  if (raw.trim() === "") return null;
  const n = parseNumberIn(getActiveLocale(), raw);
  return n === null ? undefined : n;
}

/** Clamp into [min, max] where those bounds exist. */
function clampToRange(n: number, min?: number, max?: number): number {
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

/**
 * One ArrowUp (+1) / ArrowDown (-1) press: `current` moved by `step` (1 when
 * absent or "any", as a native number input steps), without float noise, and
 * clamped into [min, max]. A blank box steps from 0.
 */
export function stepNumberFieldValue(
  current: number | null,
  direction: 1 | -1,
  step?: number | "any",
  min?: number,
  max?: number,
): number {
  const size = typeof step === "number" && Number.isFinite(step) && step > 0 ? step : 1;
  const next = (current ?? 0) + direction * size;
  const clean = Number(next.toPrecision(ROUND_TRIP_DIGITS));
  return clampToRange(Object.is(clean, -0) ? 0 : clean, min, max);
}

export interface NumberInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step"
  > {
  /** The committed number, or null for blank. */
  value: number | null;
  /** Called with each new number while typing (and on each arrow step), and
   *  with null when the box is emptied. Never called for half-typed or
   *  foreign-locale text ("-", "1e", "1.5" under de-DE). */
  onChange: (value: number | null) => void;
  /** Lower bound: enforced when the box loses focus and by the arrow step. */
  min?: number;
  /** Upper bound, enforced the same way. */
  max?: number;
  /** ArrowUp/ArrowDown step. Default 1. */
  step?: number | "any";
  /** data-testid for the <input>. */
  testId?: string;
}

/**
 * A bare number <input> in the APP locale, for a caller that styles its own
 * box (NumberField is this on the field chrome). Keeps what the user is typing
 * as a local DRAFT while it differs from a number -- so "-", "1," and "1e"
 * survive the controlled re-render -- and reports a number only when the text
 * is one. ArrowUp/ArrowDown step it the way a native number input did. When
 * focus leaves, the draft is dropped (the box shows the committed value again)
 * and min/max are enforced. Every other HTML prop and the ref go to the input;
 * a caller's onKeyDown runs first and may preventDefault the step.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, min, max, step, testId, onBlur, onKeyDown, ...rest },
  ref,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatNumberFieldValue(value);

  return (
    <input
      data-testid={testId}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      {...rest}
      ref={ref}
      type="text"
      // A native number input was a spinbutton; this one still steps.
      role="spinbutton"
      aria-valuenow={value ?? undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={shown}
      value={shown}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const parsed = parseNumberFieldText(raw);
        if (parsed !== undefined) onChange(parsed);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        const typed = parseNumberFieldText(e.currentTarget.value);
        const base = typeof typed === "number" ? typed : value;
        const next = stepNumberFieldValue(base, e.key === "ArrowUp" ? 1 : -1, step, min, max);
        setDraft(formatNumberFieldValue(next));
        onChange(next);
      }}
      onBlur={(e) => {
        onBlur?.(e);
        const parsed = parseNumberFieldText(e.currentTarget.value);
        if (typeof parsed === "number") {
          const clamped = clampToRange(parsed, min, max);
          if (clamped !== parsed) onChange(clamped);
        }
        // Text that never became a value is dropped: the box shows the
        // committed value again.
        setDraft(null);
      }}
    />
  );
});

const numberRow = css`
  display: inline-flex;
  align-items: center;
  gap: ${GAP_SM}px;
  min-width: 0;
  height: ${FIELD_HEIGHT}px;
  font-family: ${FONT_FAMILY};
  vertical-align: middle;
`;

const numberInput = css`
  flex: none;
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
`;

const numberLabel = css`
  flex: none;
  font-size: 12px;
  line-height: 1;
  color: ${LT.textSecondary};
  white-space: nowrap;
`;

const numberSuffix = css`
  flex: none;
  font-size: 11px;
  line-height: 1;
  color: ${LT.textSecondary};
  white-space: nowrap;
`;

export interface NumberFieldProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step" | "width" | "size"
  > {
  /** The committed number, or null for blank. */
  value: number | null;
  /** Called with each new number while typing (in the app locale) and on each
   *  arrow step, and with null when the box is emptied. Never called for
   *  half-typed or foreign-locale text ("-", "1e", "1.5" under de-DE). */
  onChange: (value: number | null) => void;
  /** Lower bound: enforced by the arrow step and when the box loses focus (a
   *  typed value below it is corrected to it). */
  min?: number;
  /** Upper bound, enforced the same way. */
  max?: number;
  /** ArrowUp/ArrowDown step. Default 1. */
  step?: number | "any";
  /** Input width in px. Default 62. */
  width?: number;
  /** What blank means; "auto" shows an "auto" placeholder. */
  blankMeans?: "auto";
  /** Unit shown after the box ("px", "%"); also the input's description. */
  suffix?: string;
  /** Visible 12px label before the box (also names the input). */
  label?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
  /** data-testid for the <input>. */
  testId?: string;
}

/**
 * A number box that can be blank: NumberInput (app-locale text, draft,
 * arrow step, clamp on blur) on the field chrome, with an optional label and
 * unit. HTML props and the ref go to the <input>; `className`/`style` go to
 * the row.
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  {
    value,
    onChange,
    min,
    max,
    step,
    width = NUMBER_FIELD_WIDTH,
    blankMeans,
    suffix,
    label,
    ariaLabel,
    testId,
    className,
    style,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const suffixId = useId();
  const inputId = rest.id ?? generatedId;
  const describedBy = suffix
    ? [rest["aria-describedby"], suffixId].filter(Boolean).join(" ")
    : rest["aria-describedby"];

  return (
    <span className={cx(numberRow, className)} style={style}>
      {label && (
        <label htmlFor={inputId} className={numberLabel}>
          {label}
        </label>
      )}
      <NumberInput
        testId={testId}
        placeholder={blankMeans === "auto" ? "auto" : undefined}
        {...rest}
        ref={ref}
        id={inputId}
        className={cx(fieldChrome, numberInput)}
        style={{ width }}
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel ?? rest["aria-label"]}
        aria-describedby={describedBy}
      />
      {suffix && (
        <span id={suffixId} className={numberSuffix}>
          {suffix}
        </span>
      )}
    </span>
  );
});
