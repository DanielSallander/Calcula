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

import React, { useState } from "react";
import styled from "styled-components";
import { useFormatCellsStore, type BorderSide } from "../hooks/useFormatCellsState";
import { ColorPicker } from "../components/ColorPicker";

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
    if (current.style !== "none") {
      setter({ style: "none", color: lineColor });
    } else {
      setter({ style: lineStyle === "none" ? "thin" : lineStyle, color: lineColor });
    }
  };

  const getBorderStyle = (side: BorderSide): React.CSSProperties => {
    if (side.style === "none") return { borderColor: "transparent" };
    const width =
      side.style === "thin"
        ? "1px"
        : side.style === "medium"
        ? "2px"
        : side.style === "thick"
        ? "3px"
        : "1px";
    const style =
      side.style === "dashed"
        ? "dashed"
        : side.style === "dotted"
        ? "dotted"
        : side.style === "double"
        ? "double"
        : "solid";
    return {
      borderColor: side.color,
      borderWidth: width,
      borderStyle: style,
    };
  };

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
              aria-pressed={borderTop.style !== "none"}
              onClick={() => toggleBorder("top", borderTop, setBorderTop)}
              data-testid="fc-border-top"
            >
              Top
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderInsideHorizontal.style !== "none"}
              aria-pressed={borderInsideHorizontal.style !== "none"}
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
              aria-pressed={borderBottom.style !== "none"}
              onClick={() => toggleBorder("bottom", borderBottom, setBorderBottom)}
              data-testid="fc-border-bottom"
            >
              Bottom
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderLeft.style !== "none"}
              aria-pressed={borderLeft.style !== "none"}
              onClick={() => toggleBorder("left", borderLeft, setBorderLeft)}
              data-testid="fc-border-left"
            >
              Left
            </BorderToggle>
            <BorderToggle
              type="button"
              $active={borderInsideVertical.style !== "none"}
              aria-pressed={borderInsideVertical.style !== "none"}
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
              aria-pressed={borderRight.style !== "none"}
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
              style={{
                borderTop: "2px solid transparent",
                borderRight: "2px solid transparent",
                borderBottom: "2px solid transparent",
                borderLeft: "2px solid transparent",
                position: "relative",
                overflow: "hidden",
                ...(({
                  borderTopColor: borderTop.style !== "none" ? borderTop.color : "transparent",
                  borderTopWidth: borderTop.style !== "none" ? getBorderStyle(borderTop).borderWidth : "2px",
                  borderTopStyle: borderTop.style !== "none" ? (getBorderStyle(borderTop).borderStyle as string) : "solid",
                  borderRightColor: borderRight.style !== "none" ? borderRight.color : "transparent",
                  borderRightWidth: borderRight.style !== "none" ? getBorderStyle(borderRight).borderWidth : "2px",
                  borderRightStyle: borderRight.style !== "none" ? (getBorderStyle(borderRight).borderStyle as string) : "solid",
                  borderBottomColor: borderBottom.style !== "none" ? borderBottom.color : "transparent",
                  borderBottomWidth: borderBottom.style !== "none" ? getBorderStyle(borderBottom).borderWidth : "2px",
                  borderBottomStyle: borderBottom.style !== "none" ? (getBorderStyle(borderBottom).borderStyle as string) : "solid",
                  borderLeftColor: borderLeft.style !== "none" ? borderLeft.color : "transparent",
                  borderLeftWidth: borderLeft.style !== "none" ? getBorderStyle(borderLeft).borderWidth : "2px",
                  borderLeftStyle: borderLeft.style !== "none" ? (getBorderStyle(borderLeft).borderStyle as string) : "solid",
                }) as React.CSSProperties),
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
                  the boundaries between its rows / columns. */}
              {borderInsideHorizontal.style !== "none" && (
                <div
                  style={{
                    position: "absolute", left: 0, right: 0, top: "50%",
                    borderTopWidth: getBorderStyle(borderInsideHorizontal).borderWidth,
                    borderTopStyle: getBorderStyle(borderInsideHorizontal).borderStyle as React.CSSProperties["borderTopStyle"],
                    borderTopColor: borderInsideHorizontal.color,
                    pointerEvents: "none",
                  }}
                />
              )}
              {borderInsideVertical.style !== "none" && (
                <div
                  style={{
                    position: "absolute", top: 0, bottom: 0, left: "50%",
                    borderLeftWidth: getBorderStyle(borderInsideVertical).borderWidth,
                    borderLeftStyle: getBorderStyle(borderInsideVertical).borderStyle as React.CSSProperties["borderLeftStyle"],
                    borderLeftColor: borderInsideVertical.color,
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

const BorderToggle = styled.button<{ $active: boolean }>`
  padding: 4px 10px;
  font-size: 11px;
  background: ${(p) => (p.$active ? v("--accent-primary") : v("--grid-bg"))};
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
