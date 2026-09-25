//! FILENAME: app/extensions/CanvasSheet/components/CommitNumberField.tsx
// PURPOSE: A NumberField that COMMITS instead of reporting every keystroke:
//          on Enter, on an arrow-key step, and when focus leaves.
// CONTEXT: @api/layout's NumberField calls onChange with every number the box
//          holds while the user types. For a canvas layout each call is a
//          backend write, and the intermediate values are nonsense: typing 25
//          into Grid size passes through 2 (below the minimum of 4), typing
//          1920 into the page width passes through 1, 19 and 192. Committing
//          only at the end sends one value, the one the user meant, clamped
//          into range -- so a half-typed number is never refused out loud.

import React, { useEffect, useRef, useState } from "react";
import { NumberField, type NumberFieldProps } from "@api/layout";

export interface CommitNumberFieldProps
  extends Omit<NumberFieldProps, "value" | "onChange" | "onBlur" | "onFocus" | "onKeyUp" | "onKeyDown"> {
  /** The committed value. */
  value: number;
  /** Called once per commit, with a whole number clamped into [min, max], and
   *  only when it differs from `value`. */
  onCommit: (value: number) => void;
}

/** The value a draft commits to: whole, clamped, or null for nothing to commit. Pure. */
export function commitValue(draft: number | null, min?: number, max?: number): number | null {
  if (draft === null || !Number.isFinite(draft)) return null;
  let v = Math.round(draft);
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

export function CommitNumberField({ value, onCommit, min, max, ...rest }: CommitNumberFieldProps): React.ReactElement {
  const [draft, setDraft] = useState<number | null>(null);
  const focused = useRef(false);
  // The committed value moved (our own commit landing, or a script/undo):
  // whatever was being typed is superseded.
  useEffect(() => {
    setDraft(null);
  }, [value]);

  const commit = (): void => {
    const v = commitValue(draft, min, max);
    setDraft(null);
    if (v !== null && v !== value) onCommit(v);
  };

  return (
    <NumberField
      {...rest}
      min={min}
      max={max}
      value={draft ?? value}
      onChange={(v) => {
        // NumberField also reports its own blur-time clamp AFTER onBlur; by
        // then this field has already committed, so that report is ignored.
        if (focused.current) setDraft(v);
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      onKeyUp={(e) => {
        // The arrow keys step the value; each step is a deliberate change.
        if (e.key === "ArrowUp" || e.key === "ArrowDown") commit();
      }}
    />
  );
}
