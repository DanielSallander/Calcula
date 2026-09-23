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

import React, { forwardRef, useId, useState } from "react";
import { css, cx } from "@emotion/css";
import { useSurfaceLayout } from "../context";
import { LT } from "../theme";
import { FIELD_HEIGHT, FONT_FAMILY, GAP_SM, GAP_XS, LABEL_FONT_SIZE, ROW_GAP } from "../tokens";

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
    opacity: 0.5;
    cursor: default;
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
// NumberField
// ============================================================================

/** Default NumberField width: four digits and a sign at 12px. */
export const NUMBER_FIELD_WIDTH = 62;

/** Display text for a committed number: blank for null, and without binary
 *  float noise (0.1 + 0.2 shows "0.3", not "0.30000000000000004"). Fifteen
 *  significant digits is the most a double round-trips exactly. */
export function formatNumberFieldValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return String(parseFloat(value.toPrecision(15)));
}

/**
 * What the box's text means: `null` for blank, a number, or `undefined` for
 * text that is not (yet) a number and must not be reported. `badInput` is the
 * browser's own flag for a half-typed "1." or "-", which it reports as "".
 */
export function parseNumberFieldText(raw: string, badInput = false): number | null | undefined {
  if (raw.trim() === "") return badInput ? undefined : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Clamp into [min, max] where those bounds exist. */
function clampToRange(n: number, min?: number, max?: number): number {
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

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
  /** Called with each new number while typing, and with null when the box is
   *  emptied. Never called for half-typed text ("-", "1."). */
  onChange: (value: number | null) => void;
  /** Lower bound: offered to the spinner, and enforced when the box loses
   *  focus (a typed value below it is corrected to it). */
  min?: number;
  /** Upper bound, enforced the same way. */
  max?: number;
  /** Spinner/arrow-key step. Default: the browser's (1). */
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
 * A number box that can be blank. Keeps what the user is typing as a local
 * DRAFT while the box has focus — so "-", "1." and "1e" survive the controlled
 * re-render — and reports a number only when the text is one. When focus
 * leaves, the draft is dropped (the box shows the committed value again) and
 * min/max are enforced. HTML props and the ref go to the <input>;
 * `className`/`style` go to the row.
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
  const [draft, setDraft] = useState<string | null>(null);

  const shown = draft ?? formatNumberFieldValue(value);
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
      <input
        data-testid={testId}
        placeholder={blankMeans === "auto" ? "auto" : undefined}
        inputMode="decimal"
        {...rest}
        ref={ref}
        id={inputId}
        type="number"
        className={cx(fieldChrome, numberInput)}
        style={{ width }}
        value={shown}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel ?? rest["aria-label"]}
        aria-describedby={describedBy}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const parsed = parseNumberFieldText(raw, e.target.validity?.badInput ?? false);
          if (parsed !== undefined) onChange(parsed);
        }}
        onBlur={(e) => {
          rest.onBlur?.(e);
          const el = e.currentTarget;
          const parsed = parseNumberFieldText(el.value, el.validity?.badInput ?? false);
          if (typeof parsed === "number") {
            const clamped = clampToRange(parsed, min, max);
            if (clamped !== parsed) onChange(clamped);
          }
          // Half-typed text never became a value: clear it from the DOM too,
          // or a blank committed value (React sees "" == "") would leave the
          // garbage on screen.
          if (el.validity?.badInput) el.value = "";
          setDraft(null);
        }}
      />
      {suffix && (
        <span id={suffixId} className={numberSuffix}>
          {suffix}
        </span>
      )}
    </span>
  );
});
