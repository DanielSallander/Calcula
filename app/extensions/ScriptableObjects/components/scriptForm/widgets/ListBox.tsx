//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/widgets/ListBox.tsx
// PURPOSE: The `listbox` form widget — a native multi-row <select>, multiple
//          when the spec says so. Yields string[] for `multi`, else a string.
//          Marked `data-form-listbox` so the dialog's Enter handler leaves it
//          alone (Enter inside a list is a selection gesture, not Submit).

import React from "react";
import type { FormOption } from "@api/scriptHost/scriptFormSpec";
import * as S from "../ScriptFormDialog.styles";

export interface ListBoxProps {
  id: string;
  widgetName: string;
  options: FormOption[];
  multi: boolean;
  /** string[] when multi, else the single selected value. */
  value: string | string[];
  rows: number;
  disabled: boolean;
  required: boolean;
  autoFocus: boolean;
  /** True while this listbox's answer is refused; announced, not just coloured. */
  invalid?: boolean;
  /** ids of the help / error text under it (aria-describedby). */
  describedBy?: string | undefined;
  onChange: (value: string | string[]) => void;
}

export function ListBox({
  id,
  widgetName,
  options,
  multi,
  value,
  rows,
  disabled,
  required,
  autoFocus,
  invalid,
  describedBy,
  onChange,
}: ListBoxProps): React.ReactElement {
  const selected = multi ? (Array.isArray(value) ? value : []) : Array.isArray(value) ? value[0] ?? "" : value;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    if (multi) {
      const chosen: string[] = [];
      for (const option of Array.from(e.target.options)) {
        if (option.selected) chosen.push(option.value);
      }
      onChange(chosen);
      return;
    }
    onChange(e.target.value);
  };

  return (
    <S.ListSelect
      id={id}
      data-form-widget={widgetName}
      data-form-listbox=""
      multiple={multi}
      size={Math.max(2, rows)}
      value={selected}
      disabled={disabled}
      aria-required={required || undefined}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      autoFocus={autoFocus}
      onChange={handleChange}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label ?? option.value}
        </option>
      ))}
    </S.ListSelect>
  );
}
