//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/AlignmentTab.tsx
// PURPOSE: Alignment tab for the Format Cells dialog.

import React from "react";
import styled from "styled-components";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";

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

const ROTATION_OPTIONS = [
  { value: "none", label: "0 degrees" },
  { value: "rotate90", label: "90 degrees" },
  { value: "rotate270", label: "-90 degrees" },
];

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
            <FieldLabel>Indent level:</FieldLabel>
            <IndentRow>
              <IndentButton
                onClick={() => setIndent(Math.max(0, indent - 1))}
                disabled={indent <= 0}
                title="Decrease indent"
              >
                -
              </IndentButton>
              <IndentValue>{indent}</IndentValue>
              <IndentButton
                onClick={() => setIndent(Math.min(15, indent + 1))}
                disabled={indent >= 15}
                title="Increase indent"
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
        <FieldGroup>
          <FieldLabel>Text rotation:</FieldLabel>
          <Select
            value={textRotation}
            onChange={(e) => setTextRotation(e.target.value)}
          >
            {ROTATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </FieldGroup>

        {/* Visual preview of alignment */}
        <PreviewBox>
          <PreviewText
            style={{
              textAlign: textAlign === "general" ? "left" : (textAlign as React.CSSProperties["textAlign"]),
              verticalAlign: verticalAlign as React.CSSProperties["verticalAlign"],
              paddingLeft: indent > 0 ? `${indent * 8}px` : undefined,
              fontSize: shrinkToFit ? "10px" : undefined,
            }}
          >
            Sample Text
          </PreviewText>
        </PreviewBox>
      </Section>
    </Container>
  );
}

// Styled Components
const Container = styled.div`
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
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

const IndentValue = styled.span`
  min-width: 28px;
  text-align: center;
  font-size: 13px;
  color: ${v("--text-primary")};
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
`;

const PreviewText = styled.div`
  width: 100%;
  font-size: 13px;
  color: ${v("--text-primary")};
  display: flex;
  align-items: center;
`;
