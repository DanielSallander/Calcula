//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/FontField.tsx
// PURPOSE: The font-family row of the Title card: the common families, the
//          object's own family when it is another one, and "Default" (clears
//          the literal back to the family's font).
// CONTEXT: Every offered family passes `isSafeFontFamily` (letters, digits,
//          spaces, commas, apostrophes, hyphens -- never a quote that could
//          close a CSS string); the seam refuses anything else anyway.

import React from "react";
import { isSafeFontFamily, readContainerField, type ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { FONT_FAMILY_OPTIONS } from "../../lib/formatValues";
import { SelectBox } from "./SelectField";
import { FormatRow } from "./FormatRow";

const DEFAULT_VALUE = "";

export interface FontFieldProps {
  fieldId: ContainerFieldId;
  label: string;
}

export function FontField({ fieldId, label }: FontFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const stored = readContainerField(ctx.snapshot.stored, fieldId);
  const value = typeof stored === "string" ? stored : DEFAULT_VALUE;
  const options: Array<readonly [string, string]> = [[DEFAULT_VALUE, "Default"]];
  for (const f of FONT_FAMILY_OPTIONS) options.push([f, f]);
  if (value !== DEFAULT_VALUE && !FONT_FAMILY_OPTIONS.includes(value) && isSafeFontFamily(value)) {
    options.push([value, value]);
  }
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <SelectBox
        value={value}
        options={options}
        onCommit={(v) => void ctx.commitField(fieldId, v === DEFAULT_VALUE ? null : v)}
        disabled={ctx.readOnly}
        ariaLabel={label}
        testId={`format-${fieldId}`}
      />
    </FormatRow>
  );
}
