//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/widgets/RadioGroup.tsx
// PURPOSE: The `radio` form widget — native radios sharing one group name,
//          laid out in a row or a column. Native so keyboard navigation
//          (arrow keys between options) and screen-reader semantics come for
//          free; the group name carries the showId so two open surfaces can
//          never share a radio group by accident.

import React from "react";
import type { FormOption } from "@api/scriptHost/scriptFormSpec";
import * as S from "../ScriptFormDialog.styles";

export interface RadioGroupProps {
  /** `${showId}:${name}` — unique per open form. */
  groupName: string;
  /** The widget name; goes on the wrapper for e2e and for focus requests. */
  widgetName: string;
  label: string;
  required: boolean;
  options: FormOption[];
  value: string;
  layout: "row" | "column";
  disabled: boolean;
  autoFocus: boolean;
  /** True while this group's answer is refused; announced, not just coloured. */
  invalid?: boolean;
  /** ids of the help / error text under the group (aria-describedby). */
  describedBy?: string | undefined;
  onChange: (value: string) => void;
}

export function RadioGroup({
  groupName,
  widgetName,
  label,
  required,
  options,
  value,
  layout,
  disabled,
  autoFocus,
  invalid,
  describedBy,
  onChange,
}: RadioGroupProps): React.ReactElement {
  // autoFocus lands on the checked option, else the first one — the same
  // element the browser would tab to.
  const focusIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <S.RadioFieldset
      $row={layout === "row"}
      data-form-widget={widgetName}
      aria-required={required || undefined}
      // A radio group and a listbox were the two inputs that never reported
      // being invalid, so a screen-reader user was told nothing about the one
      // field blocking the submit.
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      {label ? (
        <S.RadioLegend>
          {label}
          {required ? <S.Required>*</S.Required> : null}
        </S.RadioLegend>
      ) : null}
      {options.map((option, i) => (
        <S.RadioOption key={option.value}>
          <input
            type="radio"
            name={groupName}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            autoFocus={autoFocus && i === focusIndex}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label ?? option.value}</span>
        </S.RadioOption>
      ))}
    </S.RadioFieldset>
  );
}
