//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/SelectField.tsx
// PURPOSE: A choice row of a Format card (alignment, heading level, line
//          style, shadow position...). A pick commits at once.

import React from "react";
import type { ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { literalFieldValue } from "../../lib/formatValues";
import { paneStyles } from "../paneStyles";
import { FormatRow } from "./FormatRow";

export interface SelectBoxProps {
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onCommit: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}

export function SelectBox({ value, options, onCommit, disabled, ariaLabel, testId }: SelectBoxProps): React.ReactElement {
  const known = options.some(([v]) => v === value);
  return (
    <select
      style={paneStyles.select}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(e) => {
        if (e.target.value !== value) onCommit(e.target.value);
      }}
    >
      {!known && <option value={value}>{value}</option>}
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

export interface SelectFieldProps {
  fieldId: ContainerFieldId;
  label: string;
  /** [stored value, label]; a numeric field's values are written as numbers. */
  options: ReadonlyArray<readonly [string | number, string]>;
  disabled?: boolean;
}

export function SelectField({ fieldId, label, options, disabled }: SelectFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const raw = literalFieldValue(ctx.snapshot, fieldId);
  const numeric = options.length > 0 && typeof options[0][0] === "number";
  const asText = options.map(([v, text]) => [String(v), text] as const);
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <SelectBox
        value={raw === undefined || raw === null ? "" : String(raw)}
        options={asText}
        onCommit={(v) => void ctx.commitField(fieldId, numeric ? Number(v) : v)}
        disabled={ctx.readOnly || disabled}
        ariaLabel={label}
        testId={`format-${fieldId}`}
      />
    </FormatRow>
  );
}
