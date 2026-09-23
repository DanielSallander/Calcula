//! FILENAME: app/extensions/Controls/PropertiesPane/SliderInput.tsx
// PURPOSE: Combined slider + number box for bounded numeric properties.
// CONTEXT: Used for opacity, rotation, font size, etc. in the Properties Pane.
//          A thin adapter over the @api/layout Slider and NumberField (Calcula
//          Clusters), kept under its old name and props because PropertyRow
//          imports it. The primitives paint the track, fill, thumb and box with
//          tokens; the range it replaced was OS-drawn and ignored the skin.
//
//          Behaviour is the old component's, on purpose:
//          - dragging reports every step through BOTH onChange and onCommit,
//            as the bare range did (React's onChange on a range IS the input
//            event), so the object keeps previewing live while it is dragged;
//          - the number box commits only on Enter or when it loses focus,
//            clamped to [min, max]; text that is not a number reverts.

import React, { useCallback } from "react";
import { NumberField, Slider } from "@api/layout";

// ============================================================================
// Props
// ============================================================================

interface SliderInputProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

// ============================================================================
// Component
// ============================================================================

/** Room for "-360" or "0.25" at 12px. */
const NUMBER_BOX_WIDTH = 58;

const containerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const sliderStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

export const SliderInput: React.FC<SliderInputProps> = ({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}) => {
  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, v)),
    [min, max],
  );

  const handleRange = useCallback(
    (v: number) => {
      if (Number.isNaN(v)) return;
      onChange(v);
      onCommit(clamp(v));
    },
    [onChange, onCommit, clamp],
  );

  /** Commit what the box holds (clamped); anything that is not a number is
   *  dropped and the box shows the current value again on blur. */
  const commitBox = useCallback(
    (raw: string) => {
      if (raw.trim() === "") return;
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      onCommit(clamp(v));
    },
    [onCommit, clamp],
  );

  return (
    <div style={containerStyle}>
      <Slider
        value={clamp(value)}
        min={min}
        max={max}
        step={step}
        onChange={handleRange}
        readout={false}
        ariaLabel="Value"
        style={sliderStyle}
      />
      <NumberField
        value={value}
        // The box keeps its own draft while focused; the value is committed on
        // Enter or blur, never per keystroke.
        onChange={() => undefined}
        min={min}
        max={max}
        step={step}
        width={NUMBER_BOX_WIDTH}
        ariaLabel="Value"
        onBlur={(e) => commitBox(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Enter ends the edit the way leaving the box does, so the commit
          // runs once, in onBlur.
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </div>
  );
};
