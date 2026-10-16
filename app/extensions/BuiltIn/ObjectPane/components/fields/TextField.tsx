//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/TextField.tsx
// PURPOSE: A text row of a Format card (title / subtitle text). Local draft,
//          commit on blur or Enter, Escape puts the committed text back and
//          writes nothing. An unchanged commit is not a write.

import React, { useEffect, useRef, useState } from "react";
import { VISUAL_CONTAINER_LIMITS, type ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { literalFieldValue } from "../../lib/formatValues";
import { paneStyles } from "../paneStyles";
import { FormatRow } from "./FormatRow";

export interface TextBoxProps {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  maxLength?: number;
  testId?: string;
}

export function TextBox({ value, onCommit, disabled, ariaLabel, placeholder, maxLength, testId }: TextBoxProps): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = (text: string): void => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (text === value) return;
    onCommit(text);
  };

  return (
    <input
      type="text"
      style={paneStyles.input}
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      data-testid={testId}
      onFocus={() => {
        editing.current = true;
        cancelled.current = false;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        editing.current = false;
        commit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          cancelled.current = true;
          editing.current = false;
          setDraft(value);
        }
      }}
    />
  );
}

export interface TextFieldProps {
  fieldId: ContainerFieldId;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

/** A container text field ("" clears the literal back to the family's). */
export function TextField({ fieldId, label, placeholder, disabled }: TextFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const raw = literalFieldValue(ctx.snapshot, fieldId);
  const value = typeof raw === "string" ? raw : "";
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <TextBox
        value={value}
        onCommit={(text) => void ctx.commitField(fieldId, text === "" ? null : text)}
        disabled={ctx.readOnly || disabled}
        ariaLabel={label}
        placeholder={placeholder}
        maxLength={VISUAL_CONTAINER_LIMITS.textMaxChars}
        testId={`format-${fieldId}`}
      />
    </FormatRow>
  );
}
