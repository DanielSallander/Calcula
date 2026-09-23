//! FILENAME: app/extensions/_standard/conditional-formatting/components/ColorPicker.tsx
// PURPOSE: The colour picker of the conditional-formatting rule editor
//          (a rule's background and text colour).
// CONTEXT: A thin adapter over the ONE @api colour picker: a ColorSwatch whose
//          click opens ColorPopover with this editor's preset colours, a "None"
//          row (the old Clear button: the rule leaves that colour alone), "More
//          colours..." with the OS picker and a hex field. It used to draw its
//          own trigger, a position:absolute 4x6 grid, its own document mousedown
//          listener for click-outside and a hex box that committed any string
//          matching the pattern; the popover now owns placement, dismissal,
//          keyboard and focus return, and a typed hex is committed only when it
//          is a whole colour.
//
//          No theme grid: a rule stores a flat hex, so a "theme colour" picked
//          here would not follow a theme change — offering one would promise a
//          behaviour the rule cannot keep.

import React from "react";
import { ColorSwatch, LT, GAP_SM, FONT_FAMILY, FONT_MONO } from "@api/layout";

// ============================================================================
// Preset Colors (colour DATA: rendered by ColorPopover as data-colour-data
// swatches, never as chrome)
// ============================================================================

const PRESET_COLORS: readonly string[] = [
  // Reds
  "#ff0000", "#ff6b6b", "#ffc7ce", "#9c0006",
  // Oranges/Yellows
  "#ff9800", "#ffc000", "#ffeb9c", "#9c5700",
  // Greens
  "#00aa00", "#4caf50", "#c6efce", "#006100",
  // Blues
  "#0078d4", "#5b9bd5", "#bdd7ee", "#003366",
  // Purples/Grays
  "#9c27b0", "#ce93d8", "#d9d9d9", "#333333",
  // Special
  "#ffffff", "#f5f5f5", "#e0e0e0", "#000000",
];

// ============================================================================
// Props
// ============================================================================

export interface ColorPickerProps {
  value?: string;
  onChange: (color: string | undefined) => void;
  /** Accessible name of the swatch and its popover. Default "Colour". */
  label?: string;
}

// ============================================================================
// Styles
// ============================================================================

const rowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: GAP_SM,
  fontFamily: FONT_FAMILY,
};

/** The current value in words ("None" or the hex), as the old trigger showed. */
const valueStyle: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 11,
  color: LT.textSecondary,
};

// ============================================================================
// Component
// ============================================================================

export function ColorPicker({ value, onChange, label = "Colour" }: ColorPickerProps): React.ReactElement {
  const current = value || null;
  return (
    <span style={rowStyle}>
      <ColorSwatch
        color={current}
        onChange={onChange}
        label={label}
        chevron
        tooltip={current ? `${label}: ${current}` : `${label}: None`}
        showTheme={false}
        colors={PRESET_COLORS}
        colorsHeading="Preset colours"
        allowAutomatic
        automaticLabel="None"
        // "None" means NO colour (the rule leaves it alone), not the default
        // ink, so its chip is an empty outline rather than a text-coloured one.
        automaticChip="none"
        onAutomatic={() => onChange(undefined)}
      />
      <span style={valueStyle}>{current ?? "None"}</span>
    </span>
  );
}
