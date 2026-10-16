//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/ToggleField.tsx
// PURPOSE: An on/off row of a Format card (title on, wrap, bold, shadow on...).
//          A click commits at once: one toggle, one undo step.

import React, { useEffect, useState } from "react";
import type { ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { literalFieldValue } from "../../lib/formatValues";
import { FormatRow } from "./FormatRow";

export interface ToggleBoxProps {
  checked: boolean;
  /** A returned promise is the write: the box shows the new value until it settles. */
  onCommit: (checked: boolean) => void | Promise<unknown>;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}

export function ToggleBox({ checked, onCommit, disabled, ariaLabel, testId }: ToggleBoxProps): React.ReactElement {
  // THE IN-FLIGHT VALUE. `checked` is the stored value, and for a family whose
  // write goes to the backend (a floating grid's title bar) the snapshot only
  // moves when that write has answered. Without this React put the tick
  // straight back on the next render, so the click visibly bounced and an
  // automated uncheck read "did not change its state" (live, 2026-10-16).
  // Cleared when the stored value moves, and when the write settles -- a
  // refused write must show the stored value again.
  const [inFlight, setInFlight] = useState<boolean | null>(null);
  useEffect(() => setInFlight(null), [checked]);
  return (
    <input
      type="checkbox"
      checked={inFlight ?? checked}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      style={{ margin: "5px 0 0", cursor: disabled ? "default" : "pointer" }}
      onChange={(e) => {
        const next = e.target.checked;
        setInFlight(next);
        const write = onCommit(next);
        if (write && typeof (write as Promise<unknown>).finally === "function") {
          void (write as Promise<unknown>).catch(() => undefined).finally(() => setInFlight(null));
        } else {
          setInFlight(null);
        }
      }}
    />
  );
}

export interface ToggleFieldProps {
  fieldId: ContainerFieldId;
  label: string;
  disabled?: boolean;
}

export function ToggleField({ fieldId, label, disabled }: ToggleFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const checked = literalFieldValue(ctx.snapshot, fieldId) === true;
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <ToggleBox
        checked={checked}
        onCommit={(next) => ctx.commitField(fieldId, next)}
        disabled={ctx.readOnly || disabled}
        ariaLabel={label}
        testId={`format-${fieldId}`}
      />
    </FormatRow>
  );
}
