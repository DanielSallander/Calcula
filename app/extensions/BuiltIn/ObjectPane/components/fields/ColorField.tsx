//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/ColorField.tsx
// PURPOSE: A colour row of a Format card: the OS colour picker, the hex code,
//          and "Default" (clears the literal back to the family's colour).
// CONTEXT: While the picker DRAGS (its `input` events) the colour is PREVIEWED
//          on the object (@api/objectFormat `previewObjectFormat`: the family's
//          local cache only -- no write, no undo, no dirty flag). The picker's
//          native `change` (it closed on a colour) COMMITS once: the LAST step
//          of the pick, compared with the colour STORED when the pick started
//          (the preview rewrites `value` while it drags, so `value` at `change`
//          time is the picked colour itself). Picking the stored colour back,
//          or a blur without a change, ends the preview. The picker is driven
//          by the shared `useNativeColorPick` (round 2, G1: this box used to be
//          CONTROLLED by `value`, so React's restore put the old colour back
//          into the DOM and the `change` never committed). The hex box commits
//          a typed #rgb, #rrggbb or #rrggbbaa on blur or Enter; anything else
//          is shown as refused and writes nothing.

import React, { useEffect, useRef, useState } from "react";
import { isSafeVisualColor, readContainerField, type ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { literalFieldValue } from "../../lib/formatValues";
import { paneStyles } from "../paneStyles";
import { FormatRow } from "./FormatRow";
import { pickerHex, useNativeColorPick } from "../../../../_shared/components/colorPick";

/** The 6-digit form an `<input type="color">` accepts -- ONE definition, in the
 *  shared colour-pick module; re-exported so existing importers are unchanged. */
export { pickerHex };

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
  // `input` = a preview step, the native `change` = ONE commit (one undo step).
  const picker = useNativeColorPick({ value, onStep: onPreview, onCommit, onEnd: onEndPreview });
  const [hexDraft, setHexDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const editingHex = useRef(false);

  useEffect(() => {
    if (!editingHex.current) setHexDraft(value);
    setInvalid(false);
  }, [value]);

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
        {...picker}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        style={{ width: 28, height: 24, padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
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
