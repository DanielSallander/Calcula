//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/AlignmentTab.tsx
// PURPOSE: Alignment tab for the Format Cells dialog.
// CONTEXT: Orientation is Excel's: an angle in DEGREES from -90 to 90 (five
//          one-click angles plus a Degrees field) and the stacked "Text" box --
//          Excel's Vertical Text. It used to be a select of 0 / 90 / -90, so a
//          cell at 45 degrees (the Home tab's Angle Counterclockwise) opened
//          showing nothing it could select, and stacked text could not be set
//          here at all. The Indent goes to Excel's 250 (it was capped at 15).

import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import {
  MAX_INDENT,
  clampIndent,
  orientationOf,
  textRotationForDegrees,
} from "../lib/alignmentValues";

const v = (name: string) => `var(${name})`;

const H_ALIGN_OPTIONS = [
  { value: "general", label: "General" },
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

const V_ALIGN_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];

/** The one-click angles, top to bottom as on Excel's orientation dial. */
const ANGLE_PRESETS = [90, 45, 0, -45, -90] as const;

/**
 * A number field's TEXT, kept in step with the store value it edits. A value
 * that arrives from outside (the dialog's style load lands after mount) is
 * shown; a value this field itself just wrote is not echoed back, so typing
 * "-" or "4" on the way to "-45" is not overwritten mid-keystroke.
 */
function useNumberText(value: number): {
  text: string;
  setText: (t: string) => void;
  wrote: (v: number) => void;
} {
  const [text, setText] = useState(String(value));
  const written = useRef<number | null>(null);
  useEffect(() => {
    if (written.current !== value) setText(String(value));
    written.current = null;
  }, [value]);
  return {
    text,
    setText,
    wrote: (n: number) => {
      written.current = n;
    },
  };
}

/** A typed number, or null while the field holds something that is not one yet. */
function typedNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "" || t === "-" || t === "+") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function AlignmentTab(): React.ReactElement {
  const {
    textAlign,
    verticalAlign,
    wrapText,
    shrinkToFit,
    textRotation,
    indent,
    setTextAlign,
    setVerticalAlign,
    setWrapText,
    setShrinkToFit,
    setTextRotation,
    setIndent,
  } = useFormatCellsStore();

  const orientation = orientationOf(textRotation);
  const degreesText = useNumberText(orientation.degrees);
  const indentText = useNumberText(indent);

  /**
   * Set the indent the way Excel does: an indent on a General or a Center cell
   * makes it LEFT (measured: IndentLevel on either reads back as xlLeft; Right
   * stays Right). Excel has no centred indent, and the grid draws an indented
   * General value as Left -- so the dialog says what the cell will show.
   */
  const changeIndent = (level: number): void => {
    const next = clampIndent(level);
    if (next > 0 && (textAlign === "general" || textAlign === "center" || textAlign === "")) {
      setTextAlign("left");
    }
    setIndent(next);
  };

  return (
    <Container>
      {/* Text alignment section */}
      <Section>
        <SectionTitle>Text alignment</SectionTitle>
        <FieldRow>
          <FieldGroup>
            <FieldLabel>Horizontal:</FieldLabel>
            <Select
              value={textAlign}
              onChange={(e) => setTextAlign(e.target.value)}
            >
              {H_ALIGN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FieldGroup>

          <FieldGroup>
            <FieldLabel>Vertical:</FieldLabel>
            <Select
              value={verticalAlign}
              onChange={(e) => setVerticalAlign(e.target.value)}
            >
              {V_ALIGN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FieldGroup>
        </FieldRow>
      </Section>

      {/* Indent section */}
      <Section>
        <SectionTitle>Indent</SectionTitle>
        <FieldRow>
          <FieldGroup>
            <FieldLabel htmlFor="fc-indent">Indent level:</FieldLabel>
            <IndentRow>
              <IndentButton
                type="button"
                onClick={() => changeIndent(indent - 1)}
                disabled={indent <= 0}
                title="Decrease indent"
                data-testid="fc-indent-decrease"
              >
                -
              </IndentButton>
              <NumberInput
                id="fc-indent"
                type="number"
                min={0}
                max={MAX_INDENT}
                step={1}
                value={indentText.text}
                onChange={(e) => {
                  indentText.setText(e.target.value);
                  const n = typedNumber(e.target.value);
                  if (n === null) return;
                  // Excel's range is 0..250; a typed value past it is held at
                  // the limit rather than silently ignored.
                  const next = clampIndent(n);
                  indentText.wrote(next);
                  changeIndent(next);
                }}
                onBlur={() => indentText.setText(String(indent))}
                aria-label="Indent level"
                data-testid="fc-indent"
              />
              <IndentButton
                type="button"
                onClick={() => changeIndent(indent + 1)}
                disabled={indent >= MAX_INDENT}
                title="Increase indent"
                data-testid="fc-indent-increase"
              >
                +
              </IndentButton>
            </IndentRow>
          </FieldGroup>
        </FieldRow>
      </Section>

      {/* Text control section */}
      <Section>
        <SectionTitle>Text control</SectionTitle>
        <CheckboxRow>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={wrapText}
              onChange={(e) => setWrapText(e.target.checked)}
            />
            Wrap text
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={shrinkToFit}
              onChange={(e) => setShrinkToFit(e.target.checked)}
            />
            Shrink to fit
          </CheckboxLabel>
        </CheckboxRow>
      </Section>

      {/* Orientation section */}
      <Section>
        <SectionTitle>Orientation</SectionTitle>
        <OrientationRow>
          {/* Excel's left box: the stacked "Text" (Vertical Text). */}
          <StackedToggle
            type="button"
            aria-pressed={orientation.stacked}
            $active={orientation.stacked}
            onClick={() => setTextRotation("vertical")}
            title="Vertical text (one character per line)"
            data-testid="fc-orientation-stacked"
          >
            {"Text".split("").map((ch, i) => (
              <span key={i}>{ch}</span>
            ))}
          </StackedToggle>
          {/* Excel's dial, as its five one-click angles. */}
          <AngleColumn role="group" aria-label="Angle">
            {ANGLE_PRESETS.map((deg) => {
              const active = !orientation.stacked && orientation.degrees === deg;
              return (
                <AngleButton
                  key={deg}
                  type="button"
                  aria-pressed={active}
                  $active={active}
                  onClick={() => setTextRotation(textRotationForDegrees(deg))}
                  data-testid={`fc-orientation-${deg}`}
                >
                  <AngleSample style={{ transform: `rotate(${-deg}deg)` }}>Text</AngleSample>
                  <AngleLabel>{`${deg}°`}</AngleLabel>
                </AngleButton>
              );
            })}
          </AngleColumn>
        </OrientationRow>
        <FieldGroup>
          <FieldLabel htmlFor="fc-orientation-degrees">Degrees:</FieldLabel>
          <NumberInput
            id="fc-orientation-degrees"
            type="number"
            min={-90}
            max={90}
            step={1}
            value={degreesText.text}
            onChange={(e) => {
              degreesText.setText(e.target.value);
              const n = typedNumber(e.target.value);
              if (n === null) return;
              // Excel's range is -90..90. Typing an angle leaves stacked text,
              // as choosing a point on Excel's dial does.
              const clamped = Math.max(-90, Math.min(90, Math.round(n)));
              degreesText.wrote(clamped);
              setTextRotation(textRotationForDegrees(clamped));
            }}
            onBlur={() => degreesText.setText(String(orientation.degrees))}
            aria-label="Degrees"
            data-testid="fc-orientation-degrees"
          />
        </FieldGroup>

        {/* Visual preview of alignment */}
        <PreviewBox>
          <PreviewText
            style={{
              textAlign: textAlign === "general" ? "left" : (textAlign as React.CSSProperties["textAlign"]),
              verticalAlign: verticalAlign as React.CSSProperties["verticalAlign"],
              // Excel has no centred indent (the grid ignores it there too).
              paddingLeft: indent > 0 && textAlign !== "center" ? `${Math.min(indent, 20) * 8}px` : undefined,
              fontSize: shrinkToFit ? "10px" : undefined,
            }}
          >
            <span
              style={
                orientation.stacked
                  ? { writingMode: "vertical-rl", textOrientation: "upright" }
                  : { display: "inline-block", transform: `rotate(${-orientation.degrees}deg)` }
              }
            >
              Sample Text
            </span>
          </PreviewText>
        </PreviewBox>
      </Section>
    </Container>
  );
}

// Styled Components
/**
 * The four sections are independent properties of one selection, not steps, so
 * they flow into columns instead of a 416px stack: Text alignment + Indent in
 * one, Text control + Orientation in the other. `auto-fit` means they fold back
 * to a single column on their own when the dialog is dragged narrow.
 */
const Container = styled.div`
  padding: 4px 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(max(240px, calc((100% - 24px) / 2)), 1fr));
  column-gap: 24px;
  row-gap: 16px;
  align-items: start;
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const SectionTitle = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${v("--text-primary")};
  padding-bottom: 4px;
  border-bottom: 1px solid ${v("--border-default")};
`;

const FieldRow = styled.div`
  display: flex;
  gap: 20px;
`;

const FieldGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
`;

const FieldLabel = styled.label`
  font-size: 12px;
  color: ${v("--text-secondary")};
`;

const Select = styled.select`
  padding: 5px 8px;
  font-size: 13px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  outline: none;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

const CheckboxRow = styled.div`
  display: flex;
  gap: 16px;
`;

const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: ${v("--text-primary")};
  cursor: pointer;
`;

const IndentRow = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const IndentButton = styled.button<{ disabled?: boolean }>`
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${(p) => (p.disabled ? v("--text-disabled") : v("--text-primary"))};
  cursor: ${(p) => (p.disabled ? "default" : "pointer")};
  opacity: ${(p) => (p.disabled ? 0.5 : 1)};

  &:hover:not(:disabled) {
    background: ${v("--panel-bg")};
  }
`;

const NumberInput = styled.input`
  width: 64px;
  padding: 5px 8px;
  font-size: 13px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  outline: none;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

const OrientationRow = styled.div`
  display: flex;
  gap: 8px;
  align-items: stretch;
`;

/** Excel's stacked "Text" box: the word written one letter per line. */
const StackedToggle = styled.button<{ $active: boolean }>`
  width: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  font-size: 12px;
  line-height: 1.1;
  background: ${(p) => (p.$active ? v("--accent-primary") : v("--grid-bg"))};
  color: ${(p) => (p.$active ? "#ffffff" : v("--text-primary"))};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  cursor: pointer;
`;

const AngleColumn = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
`;

const AngleButton = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 8px;
  font-size: 12px;
  background: ${(p) => (p.$active ? v("--accent-primary") : v("--grid-bg"))};
  color: ${(p) => (p.$active ? "#ffffff" : v("--text-primary"))};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
`;

const AngleSample = styled.span`
  display: inline-block;
`;

const AngleLabel = styled.span`
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
`;

const PreviewBox = styled.div`
  margin-top: 8px;
  width: 100%;
  height: 60px;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  display: flex;
  padding: 4px;
  overflow: hidden;
`;

const PreviewText = styled.div`
  width: 100%;
  font-size: 13px;
  color: ${v("--text-primary")};
  display: flex;
  align-items: center;
`;
