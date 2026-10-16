//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/ColorField.tsx
// PURPOSE: A colour row of a Format card: the OS colour picker, the hex code,
//          and "Default" (clears the literal back to the family's colour).
// CONTEXT: While the picker DRAGS (its `input` events) the colour is PREVIEWED
//          on the object (@api/objectFormat `previewObjectFormat`: the family's
//          local cache only -- no write, no undo, no dirty flag). The picker's
//          `change` (it closed on a colour) COMMITS once; a blur without a
//          change ends the preview. The hex box commits a typed #rgb, #rrggbb
//          or #rrggbbaa on blur or Enter; anything else is shown as refused
//          and writes nothing.

import React, { useEffect, useRef, useState } from "react";
import { isSafeVisualColor, readContainerField, type ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { literalFieldValue } from "../../lib/formatValues";
import { paneStyles } from "../paneStyles";
import { FormatRow } from "./FormatRow";

/** The 6-digit form an `<input type="color">` accepts (it refuses #rgb and alpha). */
export function pickerHex(color: string): string {
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7).toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return ("#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
  }
  return "#000000";
}

export interface ColorBoxProps {
  /** The colour shown (hex), or "" for none / default. */
  value: string;
  onCommit: (hex: string) => void;
  onPreview?: (hex: string) => void;
  onEndPreview?: () => void;
  /** Present: a "Default" button that clears the literal. */
  onDefault?: () => void;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}

export function ColorBox({
  value,
  onCommit,
  onPreview,
  onEndPreview,
  onDefault,
  disabled,
  ariaLabel,
  testId,
}: ColorBoxProps): React.ReactElement {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [hexDraft, setHexDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const editingHex = useRef(false);
  const latest = useRef({ value, onCommit, onEndPreview });
  latest.current = { value, onCommit, onEndPreview };

  useEffect(() => {
    if (!editingHex.current) setHexDraft(value);
    setInvalid(false);
  }, [value]);

  // The picker's native `change` (it closed on a colour) is the commit; React's
  // onChange is the `input` stream while it drags (the preview).
  useEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    const onNativeChange = (): void => {
      const { value: current, onCommit: commit, onEndPreview: end } = latest.current;
      if (el.value.toLowerCase() === pickerHex(current) && current !== "") {
        end?.();
        return;
      }
      commit(el.value);
    };
    el.addEventListener("change", onNativeChange);
    return () => el.removeEventListener("change", onNativeChange);
  }, []);

  const commitHex = (raw: string): void => {
    const text = raw.trim();
    if (text === value) return;
    if (text === "" && onDefault) {
      onDefault();
      return;
    }
    if (!isSafeVisualColor(text) || text === "") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(text);
  };

  return (
    <div style={paneStyles.inline}>
      <input
        ref={pickerRef}
        type="color"
        value={pickerHex(value)}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        style={{ width: 28, height: 24, padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
        onChange={(e) => onPreview?.(e.target.value)}
        onBlur={() => onEndPreview?.()}
      />
      <input
        type="text"
        value={hexDraft}
        disabled={disabled}
        aria-label={`${ariaLabel} code`}
        aria-invalid={invalid || undefined}
        data-testid={testId ? `${testId}-hex` : undefined}
        placeholder="Default"
        style={{ ...paneStyles.input, width: 92, flex: "0 0 auto" }}
        onFocus={() => {
          editingHex.current = true;
        }}
        onChange={(e) => setHexDraft(e.target.value)}
        onBlur={(e) => {
          editingHex.current = false;
          commitHex(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitHex(e.currentTarget.value);
          } else if (e.key === "Escape") {
            editingHex.current = false;
            setHexDraft(value);
            setInvalid(false);
          }
        }}
      />
      {onDefault && (
        <button
          type="button"
          style={paneStyles.smallButton}
          disabled={disabled}
          data-testid={testId ? `${testId}-default` : undefined}
          onClick={onDefault}
        >
          Default
        </button>
      )}
      {invalid && (
        <span style={paneStyles.error} role="alert">
          Use #rgb, #rrggbb or #rrggbbaa.
        </span>
      )}
    </div>
  );
}

export interface ColorFieldProps {
  fieldId: ContainerFieldId;
  label: string;
  disabled?: boolean;
}

export function ColorField({ fieldId, label, disabled }: ColorFieldProps): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const raw = literalFieldValue(ctx.snapshot, fieldId);
  const value = typeof raw === "string" ? raw : "";
  const stored = readContainerField(ctx.snapshot.stored, fieldId);
  return (
    <FormatRow fieldId={fieldId} label={label} bindable={fieldId}>
      <ColorBox
        value={value}
        onCommit={(hex) => void ctx.commitField(fieldId, hex)}
        onPreview={(hex) => ctx.previewField(fieldId, hex)}
        onEndPreview={() => ctx.endPreview()}
        onDefault={stored !== undefined && stored !== null ? () => void ctx.commitField(fieldId, null) : undefined}
        disabled={ctx.readOnly || disabled}
        ariaLabel={label}
        testId={`format-${fieldId}`}
      />
    </FormatRow>
  );
}
