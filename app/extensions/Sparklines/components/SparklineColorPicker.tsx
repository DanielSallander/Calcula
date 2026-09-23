//! FILENAME: app/extensions/Sparklines/components/SparklineColorPicker.tsx
// PURPOSE: The labelled colour picker of the Sparkline tab's Style cluster
//          (Sparkline Color, Marker Color).
// CONTEXT: A thin composition of @api/layout primitives: a Field (label inline
//          in the ribbon band, above in a panel) around a ColorSwatch, whose
//          click opens the one @api ColorPopover offering the sparkline colour
//          list (lib/sparklineColors.ts), "More colours..." with the OS picker,
//          and a hex field. It used to be a hand-rolled button with a
//          position:fixed palette, its own document mousedown listener for
//          click-outside, a live-committing hex box (every keystroke of "#4"
//          reached the store) and hardcoded chrome colours; the popover now
//          owns placement, dismissal, keyboard and focus return, and a typed
//          hex is committed only when it is a whole colour.
//
//          No theme grid: a sparkline stores a flat hex, so a "theme colour"
//          picked here would not follow a theme change — offering one would
//          promise a behaviour the document cannot keep.

import React, { useId } from "react";
import { ColorSwatch, Field } from "@api/layout";
import { SPARKLINE_PICKER_COLORS } from "../lib/sparklineColors";

// ============================================================================
// Component
// ============================================================================

export interface SparklineColorPickerProps {
  /** Visible label, the swatch's accessible name, and the popover's name. */
  label: string;
  /** The current colour (hex). */
  value: string;
  /** A colour was picked. */
  onChange: (color: string) => void;
  /** data-testid of the swatch button; the popover gets `<testId>-popover`. */
  testId?: string;
}

export function SparklineColorPicker({
  label,
  value,
  onChange,
  testId,
}: SparklineColorPickerProps): React.ReactElement {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <ColorSwatch
        id={id}
        color={value}
        onChange={onChange}
        label={label}
        chevron
        tooltip={`${label}: ${value}`}
        showTheme={false}
        colors={SPARKLINE_PICKER_COLORS}
        colorsHeading="Colours"
        testId={testId}
      />
    </Field>
  );
}
