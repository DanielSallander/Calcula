//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/BorderTab.tsx
// PURPOSE: Border tab for the Format Cells dialog.
// CONTEXT: Excel's model. On a RANGE the Top / Bottom / Left / Right buttons are
//          the range's OUTER edges and two more buttons are the lines inside it;
//          the presets are None, Outline and Inside (Inside is offered only
//          when there is an inside). This tab only edits the store -- what OK
//          writes is decided by lib/formatCellsWrites.ts: Outline becomes ONE
//          `applyBorderPreset(..., "outside")`, None clears the range first.
//          It used to set all four sides of every cell for Outline, which on a
//          range is All Borders (survey D5). (The old header called OK a
//          no-op; borders have rendered and applied for a long time.)
//
//          A MIXED line -- an outer edge whose cells differ (BUG-0365) or an
//          inside line whose boundaries differ (BUG-0726) -- is greyed: its
//          button is not pressed and the preview draws it as Excel's grey
//          dotted line, where a real line is drawn in its own style and colour
//          [LIVE, Excel 16, 2026-11-06, lane uiforms probe3/probe4: the preview
//          pixels of a mixed inside / outer line are #C0C0C0 alternating with
//          white, 2px; a uniform thin line is #000000, 1px].

import React, { useState } from "react";
import styled from "styled-components";
import { useFormatCellsStore, type BorderSide } from "../hooks/useFormatCellsState";
import { ColorPicker } from "../components/ColorPicker";
import { previewLine } from "../lib/borderEdges";

const v = (name: string) => `var(${name})`;

const LINE_STYLES: { value: BorderSide["style"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "thin", label: "Thin" },
  { value: "medium", label: "Medium" },
  { value: "thick", label: "Thick" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
  { value: "double", label: "Double" },
];

export function BorderTab(): React.ReactElement {
  const {
    borderTop,
    borderRight,
    borderBottom,
    borderLeft,
    borderInsideHorizontal,
    borderInsideVertical,
    borderDiagonalDown,
    borderDiagonalUp,
    rangeShape,
    setBorderTop,
    setBorderRight,
    setBorderBottom,
    setBorderLeft,
    setBorderInsideHorizontal,
    setBorderInsideVertical,
    setBorderDiagonalDown,
    setBorderDiagonalUp,
    setBorderClearAll,
  } = useFormatCellsStore();

  const [lineStyle, setLineStyle] = useState<BorderSide["style"]>("thin");
  const [lineColor, setLineColor] = useState("#000000");
  const hasInside = rangeShape.multiRow || rangeShape.multiCol;

  const applyPreset = (preset: "none" | "outline" | "inside") => {
    const border: BorderSide = { style: lineStyle === "none" ? "thin" : lineStyle, color: lineColor };

    if (preset === "none") {
      // Every line of the range goes, the inside ones and the diagonals too;
      // OK clears the range FIRST and then writes whatever is drawn after this.
      const none: BorderSide = { style: "none", color: "#000000" };
      setBorderTop(none);
      setBorderRight(none);
      setBorderBottom(none);
      setBorderLeft(none);
      setBorderInsideHorizontal(none);
      setBorderInsideVertical(none);
      setBorderDiagonalDown(none);
      setBorderDiagonalUp(none);
      setBorderClearAll(true);
    } else if (preset === "outline") {
      setBorderTop(border);
      setBorderRight(border);
      setBorderBottom(border);
      setBorderLeft(border);
    } else {
      if (rangeShape.multiRow) setBorderInsideHorizontal(border);
      if (rangeShape.multiCol) setBorderInsideVertical(border);
    }
  };

  const toggleBorder = (
    side: "top" | "right" | "bottom" | "left" | "insideHorizontal" | "insideVertical" | "diagonalDown" | "diagonalUp",
    current: BorderSide,
    setter: (v: BorderSide) => void
  ) => {
    // A MIXED edge (BUG-0365: its cells draw different lines) is greyed, and a
    // click draws the chosen line along all of it -- Excel's greyed edge
    // button goes to ON, never to OFF.
    if (current.style !== "none" && !current.mixed) {
      setter({ style: "none", color: lineColor });
    } else {
      setter({ style: lineStyle === "none" ? "thin" : lineStyle, color: lineColor });
    }
  };

  /** One outer edge of the preview sample: its line, the mixed grey, or none. */
  const previewEdge = (side: BorderSide): { color: string; width: string; style: string } =>
    previewLine(side) ?? { color: "transparent", width: "2px", style: "solid" };
  const top = previewEdge(borderTop);
  const right = previewEdge(borderRight);
  const bottom = previewEdge(borderBottom);
  const left = previewEdge(borderLeft);
  const insideH = previewLine(borderInsideHorizontal);
  const insideV = previewLine(borderInsideVertical);

  return (
    <Container>
      <MainLayout>
        {/* Left: Line style and color */}
        <LeftPanel>
          <SectionTitle>Line</SectionTitle>

          <FieldLabel>Style:</FieldLabel>
          <StyleList>
            {LINE_STYLES.map((ls) => (
              <StyleItem
                key={ls.value}
                $selected={lineStyle === ls.value}
                onClick={() => setLineStyle(ls.value)}
              >
                {ls.label}
              </StyleItem>
            ))}
          </StyleList>

          <FieldLabel>Color:</FieldLabel>
          <ColorPicker value={lineColor} onChange={setLineColor} />
        </LeftPanel>

        {/* Right: Presets and Preview */}
        <RightPanel>
          {/* Presets */}
          <SectionTitle>Presets</SectionTitle>
          <PresetRow>
            <PresetButton
              type="button"
              onClick={() => applyPreset("none")}
              title="No borders"
              data-testid="fc-border-preset-none"
            >
              None
            </PresetButton>
            <PresetButton
              type="button"
              onClick={() => applyPreset("outline")}
              title="Outline: the border around the selection"
              data-testid="fc-border-preset-outline"
            >
              Outline
            </PresetButton>
            <PresetButton
              type="button"
              onClick={() => applyPreset("inside")}
              disabled={!hasInside}
              title="Inside: the lines between the selected cells"
              data-testid="fc-border-preset-inside"
            >
              Inside
            </PresetButton>
          </PresetRow>

          {/* Border buttons */}
          <SectionTitle>Border</SectionTitle>
          <BorderButtonRow>
            <BorderToggle
              type="button"
              $active={borderTop.style !== "none"}
              $mixed={Boolean(borderTop.mixed)}
              aria-pressed={borderTop.mixed ? "mixed" : borderTop.style !== "none"}
              onClick={() => toggleBorder("top", borderTop, setBorderTop)}
              data-testid="fc-border-top"
            >
              Top
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderInsideHorizontal.style !== "none"}
              $mixed={Boolean(borderInsideHorizontal.mixed)}
              aria-pressed={borderInsideHorizontal.mixed ? "mixed" : borderInsideHorizontal.style !== "none"}
              disabled={!rangeShape.multiRow}
              onClick={() => toggleBorder("insideHorizontal", borderInsideHorizontal, setBorderInsideHorizontal)}
              title="Inside horizontal (between the selected rows)"
              data-testid="fc-border-insideHorizontal"
            >
              Inside H
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderBottom.style !== "none"}
              $mixed={Boolean(borderBottom.mixed)}
              aria-pressed={borderBottom.mixed ? "mixed" : borderBottom.style !== "none"}
              onClick={() => toggleBorder("bottom", borderBottom, setBorderBottom)}
              data-testid="fc-border-bottom"
            >
              Bottom
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderLeft.style !== "none"}
              $mixed={Boolean(borderLeft.mixed)}
              aria-pressed={borderLeft.mixed ? "mixed" : borderLeft.style !== "none"}
              onClick={() => toggleBorder("left", borderLeft, setBorderLeft)}
              data-testid="fc-border-left"
            >
              Left
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderInsideVertical.style !== "none"}
              $mixed={Boolean(borderInsideVertical.mixed)}
              aria-pressed={borderInsideVertical.mixed ? "mixed" : borderInsideVertical.style !== "none"}
              disabled={!rangeShape.multiCol}
              onClick={() => toggleBorder("insideVertical", borderInsideVertical, setBorderInsideVertical)}
              title="Inside vertical (between the selected columns)"
              data-testid="fc-border-insideVertical"
            >
              Inside V
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderRight.style !== "none"}
              $mixed={Boolean(borderRight.mixed)}
              aria-pressed={borderRight.mixed ? "mixed" : borderRight.style !== "none"}
              onClick={() => toggleBorder("right", borderRight, setBorderRight)}
              data-testid="fc-border-right"
            >
              Right
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderDiagonalDown.style !== "none"}
              aria-pressed={borderDiagonalDown.style !== "none"}
              onClick={() => toggleBorder("diagonalDown", borderDiagonalDown, setBorderDiagonalDown)}
              title="Diagonal down (top-left to bottom-right)"
              data-testid="fc-border-diagonalDown"
            >
              Diag \
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderDiagonalUp.style !== "none"}
              aria-pressed={borderDiagonalUp.style !== "none"}
              onClick={() => toggleBorder("diagonalUp", borderDiagonalUp, setBorderDiagonalUp)}
              title="Diagonal up (bottom-left to top-right)"
              data-testid="fc-border-diagonalUp"
            >
              Diag /
            </BorderToggle>
          </BorderButtonRow>

          {/* Preview box */}
          <SectionTitle>Preview</SectionTitle>
          <PreviewBox>
            <PreviewCell
              data-testid="fc-border-preview"
              style={{
                position: "relative",
                overflow: "hidden",
                borderTopColor: top.color,
                borderTopWidth: top.width,
                borderTopStyle: top.style as React.CSSProperties["borderTopStyle"],
                borderRightColor: right.color,
                borderRightWidth: right.width,
                borderRightStyle: right.style as React.CSSProperties["borderRightStyle"],
                borderBottomColor: bottom.color,
                borderBottomWidth: bottom.width,
                borderBottomStyle: bottom.style as React.CSSProperties["borderBottomStyle"],
                borderLeftColor: left.color,
                borderLeftWidth: left.width,
                borderLeftStyle: left.style as React.CSSProperties["borderLeftStyle"],
              }}
            >
              {(borderDiagonalDown.style !== "none" || borderDiagonalUp.style !== "none") && (
                <svg
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
                  viewBox="0 0 80 40"
                  preserveAspectRatio="none"
                >
                  {borderDiagonalDown.style !== "none" && (
                    <line
                      x1="0" y1="0" x2="80" y2="40"
                      stroke={borderDiagonalDown.color}
                      strokeWidth={borderDiagonalDown.style === "thick" ? 3 : borderDiagonalDown.style === "medium" ? 2 : 1}
                      strokeDasharray={borderDiagonalDown.style === "dashed" ? "4 2" : borderDiagonalDown.style === "dotted" ? "1 2" : undefined}
                    />
                  )}
                  {borderDiagonalUp.style !== "none" && (
                    <line
                      x1="0" y1="40" x2="80" y2="0"
                      stroke={borderDiagonalUp.color}
                      strokeWidth={borderDiagonalUp.style === "thick" ? 3 : borderDiagonalUp.style === "medium" ? 2 : 1}
                      strokeDasharray={borderDiagonalUp.style === "dashed" ? "4 2" : borderDiagonalUp.style === "dotted" ? "1 2" : undefined}
                    />
                  )}
                </svg>
              )}
              {/* The inside lines, drawn through the middle of the sample as
                  the boundaries between its rows / columns (a mixed one in
                  Excel's grey dotted line). */}
              {insideH && (
                <div
                  data-testid="fc-border-preview-insideHorizontal"
                  style={{
                    position: "absolute", left: 0, right: 0, top: "50%",
                    borderTopWidth: insideH.width,
                    borderTopStyle: insideH.style as React.CSSProperties["borderTopStyle"],
                    borderTopColor: insideH.color,
                    pointerEvents: "none",
                  }}
                />
              )}
              {insideV && (
                <div
                  data-testid="fc-border-preview-insideVertical"
                  style={{
                    position: "absolute", top: 0, bottom: 0, left: "50%",
                    borderLeftWidth: insideV.width,
                    borderLeftStyle: insideV.style as React.CSSProperties["borderLeftStyle"],
                    borderLeftColor: insideV.color,
                    pointerEvents: "none",
                  }}
                />
              )}
              Text
            </PreviewCell>
          </PreviewBox>
        </RightPanel>
      </MainLayout>
    </Container>
  );
}

// Styled Components
const Container = styled.div`
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const MainLayout = styled.div`
  display: flex;
  gap: 16px;
`;

const LeftPanel = styled.div`
  width: 160px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const RightPanel = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const SectionTitle = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${v("--text-primary")};
  padding-bottom: 2px;
  border-bottom: 1px solid ${v("--border-default")};
`;

const FieldLabel = styled.label`
  font-size: 12px;
  color: ${v("--text-secondary")};
  margin-top: 4px;
`;

const StyleList = styled.div`
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  overflow-y: auto;
  max-height: 140px;
`;

const StyleItem = styled.div<{ $selected: boolean }>`
  padding: 3px 8px;
  cursor: pointer;
  font-size: 13px;
  background: ${(p) => (p.$selected ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$selected ? "#ffffff" : v("--text-primary"))};

  &:hover {
    background: ${(p) =>
      p.$selected ? v("--accent-primary") : v("--panel-bg")};
  }
`;

const PresetRow = styled.div`
  display: flex;
  gap: 8px;
`;

const PresetButton = styled.button`
  padding: 5px 14px;
  font-size: 12px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: ${v("--accent-primary")};
    background: ${v("--panel-bg")};
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

const BorderButtonRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

const BorderToggle = styled.button<{ $active: boolean; $mixed?: boolean }>`
  padding: 4px 10px;
  font-size: 11px;
  /* MIXED (BUG-0365): Excel's greyed edge button. */
  background: ${(p) => (p.$mixed ? v("--border-default") : p.$active ? v("--accent-primary") : v("--grid-bg"))};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${(p) => (p.$active ? "#ffffff" : v("--text-primary"))};
  cursor: pointer;

  &:hover:not(:disabled) {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

const PreviewBox = styled.div`
  width: 100%;
  height: 80px;
  background: #ffffff;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
`;

const PreviewCell = styled.div`
  width: 80px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #333;
  background: #fafafa;
`;
