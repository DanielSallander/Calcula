//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/NumberField.tsx
// PURPOSE: A number row of a Format card. The box keeps a local DRAFT while it
//          has focus and COMMITS on blur or Enter -- never per keystroke, so a
//          typed "120" is one write, not three. Escape puts the committed value
//          back and writes nothing (the pane's own Escape then returns the
//          keyboard to the grid).
// CONTEXT: `NumberBox` is the raw editor (the Properties card's geometry rows
//          use it, they are not container fields); `NumberField` is the
//          container row: it reads the literal from the format snapshot,
//          clamps into the field's own range (@api/visualContainer) and
//          commits through the format context.

import React, { useEffect, useRef, useState } from "react";
import { NumberField as LayoutNumberField, Slider } from "@api/layout";
import { parseNumber } from "@api/locale";
import { containerFieldRange, type ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { literalFieldValue } from "../../lib/formatValues";
import { FormatRow } from "./FormatRow";

export interface NumberBoxProps {
  value: number | null;
  /** The committed number (clamped into [min, max]), or null for a blank box. */
  onCommit: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
  width?: number;
}

function clamp(n: number, min?: number, max?: number): number {
  let out = n;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

export function NumberBox({
  value,
  onCommit,
  min,
  max,
  step,
  suffix,
  disabled,
  ariaLabel,
  testId,
  width,
}: NumberBoxProps): React.ReactElement {
  const [draft, setDraft] = useState<number | null>(value);
  const editing = useRef(false);
  const cancelled = useRef(false);
  const committed = useRef<number | null | undefined>(undefined);

  // Follow the object while the reader is not typing in this box.
  useEffect(() => {
    if (!editing.current) setDraft(value);
    committed.current = undefined;
  }, [value]);

  const commitText = (raw: string): void => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    // The box's text is in the APP locale ("1,5" under de-DE); text that is no
    // number there (the foreign "1.5") puts the committed value back.
    const trimmed = raw.trim();
    const n = trimmed === "" ? null : parseNumber(trimmed);
    if (trimmed !== "" && n === null) {
      setDraft(value);
      return;
    }
    const next = n === null ? null : clamp(n, min, max);
    if (committed.current === next) return;
    committed.current = next;
    if (next === value) return;
    onCommit(next);
  };

  return (
    <LayoutNumberField
      value={draft}
      onChange={(n) => setDraft(n)}
      min={min}
      max={max}
      step={step}
      suffix={suffix}
      disabled={disabled}
      ariaLabel={ariaLabel}
      testId={testId}
      width={width}
      onFocus={() => {
        editing.current = true;
        cancelled.current = false;
      }}
      onBlur={(e) => {
        editing.current = false;
        commitText(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitText(e.currentTarget.value);
        } else if (e.key === "Escape") {
          cancelled.current = true;
          editing.current = false;
          setDraft(value);
        }
      }}
    />
  );
}

export interface SliderFieldProps {
  fieldId: ContainerFieldId;
  label: string;
  suffix?: string;
  disabled?: boolean;
}

/**
 * A container number shown as a slider (transparency): every step of a drag
 * PREVIEWS on the object, the end of the drag COMMITS once (one undo step), and
 * leaving it ends any preview still standing.
 */
export function SliderField({ fieldId, label, suffix, disabled }: SliderFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  const [live, setLive] = useState<number | null>(null);
  if (!ctx.snapshot) return null;
  const raw = literalFieldValue(ctx.snapshot, fieldId);
  const value = typeof raw === "number" ? raw : 0;
  const range = containerFieldRange(fieldId) ?? [0, 100];
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <span onBlur={() => ctx.endPreview()} style={{ display: "block" }}>
        <Slider
          value={live ?? value}
          min={range[0]}
          max={range[1]}
          step={1}
          suffix={suffix}
          disabled={ctx.readOnly || disabled}
          ariaLabel={label}
          testId={`format-${fieldId}`}
          onChange={(n) => {
            setLive(n);
            ctx.previewField(fieldId, n);
          }}
          onCommit={(n) => {
            setLive(null);
            void ctx.commitField(fieldId, n);
          }}
        />
      </span>
    </FormatRow>
  );
}

export interface NumberFieldProps {
  fieldId: ContainerFieldId;
  label: string;
  suffix?: string;
  step?: number;
  /** Disabled for a reason of the card's own (e.g. spacing while not custom). */
  disabled?: boolean;
}

/** A container number field (clamped into its own range; blank = back to the default). */
export function NumberField({ fieldId, label, suffix, step, disabled }: NumberFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const raw = literalFieldValue(ctx.snapshot, fieldId);
  const value = typeof raw === "number" ? raw : null;
  const range = containerFieldRange(fieldId);
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <NumberBox
        value={value}
        onCommit={(n) => void ctx.commitField(fieldId, n)}
        min={range?.[0]}
        max={range?.[1]}
        step={step}
        suffix={suffix}
        disabled={ctx.readOnly || disabled}
        ariaLabel={label}
        testId={`format-${fieldId}`}
      />
    </FormatRow>
  );
}
