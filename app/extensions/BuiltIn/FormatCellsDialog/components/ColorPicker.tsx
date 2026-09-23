//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/components/ColorPicker.tsx
// PURPOSE: The labelled colour picker of the Format Cells dialog (Font colour,
//          Border colour, the Fill tab's solid / gradient / pattern colours).
// CONTEXT: A thin adapter over the ONE @api colour picker: a ColorSwatch whose
//          click opens ColorPopover — the document theme grid with its tint
//          rows, the standard colours, "More colours..." with the OS picker and
//          a hex field. It used to draw all of that itself (a styled-components
//          10x6 grid, its own standard row, a position:absolute dropdown, its
//          own document mousedown listener for click-outside and hardcoded
//          shadow colours); ColorPopover was written to replace it without a
//          behaviour change, so the props below are the old props, unchanged:
//
//          - a theme pick calls onThemeColorChange(slot, tint, hex) when given,
//            else onChange(hex) with the resolved colour — exactly as before;
//          - a theme swatch is marked selected from themeSlot/themeTint, a
//            standard swatch from the hex when no slot is set;
//          - the OS picker reports live; a typed hex is committed only when it
//            is a whole colour (it used to hand every keystroke of "#4" to the
//            dialog state).
//
//          ONE KEYBOARD RULE THE ADAPTER ADDS. The popover portals to <body>,
//          but React bubbles its key events through the COMPONENT tree — into
//          the dialog's onKeyDown, which maps Escape to Cancel and Enter to OK.
//          The old dropdown never took focus, so that never came up; the popover
//          does (it opens on the selected swatch). Unguarded, Escape to close
//          the palette would discard the whole dialog and Enter on a swatch
//          would press OK instead of picking it. So Escape and Enter that start
//          INSIDE the popover stop here: Enter still reaches the swatch/hex
//          field (they act on it themselves), and Escape closes the popover and
//          returns focus to the swatch button. Keys on the button itself keep
//          the dialog's meaning, as they always had.

import React, { useCallback, useId, useRef } from "react";
import { ColorSwatch, LT, GAP_SM, FONT_FAMILY } from "@api/layout";

interface ColorPickerProps {
  value: string;
  /** Current theme slot (e.g. "accent1") if this color is theme-based */
  themeSlot?: string;
  /** Current theme tint (permille) if theme-based */
  themeTint?: number;
  /** Called when user picks an absolute (non-theme) color */
  onChange: (color: string) => void;
  /** Called when user picks a theme color. If not provided, falls back to onChange with resolved color. */
  onThemeColorChange?: (slot: string, tint: number, resolvedColor: string) => void;
  label?: string;
}

/** "Color 1:" -> "Color 1"; the visible label keeps its colon, the accessible
 *  name and tooltip do not. */
function accessibleName(label: string | undefined): string {
  const trimmed = (label ?? "").replace(/:\s*$/, "").trim();
  return trimmed || "Colour";
}

const rowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: GAP_SM,
};

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  color: LT.textSecondary,
};

export function ColorPicker({
  value,
  themeSlot,
  themeTint,
  onChange,
  onThemeColorChange,
  label,
}: ColorPickerProps): React.ReactElement {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const name = accessibleName(label);

  const guardPopoverKeys = useCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
    const wrap = wrapRef.current;
    // Keys on the swatch button keep the host dialog's meaning.
    if (!wrap || wrap.contains(e.target as Node)) return;
    if (e.key !== "Escape" && e.key !== "Enter") return;
    // Stopping the synthetic event also stops the native one at React's root,
    // so the popover's own document-level Escape listener never hears it:
    // close it the way a pointer user would, through its trigger.
    e.stopPropagation();
    if (e.key === "Escape") {
      const trigger = wrap.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
      if (trigger) {
        trigger.click();
        trigger.focus();
      }
    }
  }, []);

  return (
    <span ref={wrapRef} style={rowStyle} onKeyDown={guardPopoverKeys}>
      {label && (
        <label htmlFor={id} style={labelStyle}>
          {label}
        </label>
      )}
      <ColorSwatch
        id={id}
        color={value || null}
        onChange={onChange}
        onThemeColorChange={onThemeColorChange}
        themeSlot={themeSlot || undefined}
        themeTint={themeTint}
        label={name}
        chevron
        tooltip={value ? `${name}: ${value}` : name}
      />
    </span>
  );
}
