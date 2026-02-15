//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/BorderTab.tsx
// PURPOSE: Border tab for the Format Cells dialog (UI only).
// CONTEXT: Border rendering is not yet supported in the Canvas renderer.
// This tab provides the UI but apply is a no-op for now.

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
    setBorderTop,
    setBorderRight,
    setBorderBottom,
    setBorderLeft,
  } = useFormatCellsStore();

  const [lineStyle, setLineStyle] = useState<BorderSide["style"]>("thin");
  const [lineColor, setLineColor] = useState("#000000");

  const applyPreset = (preset: "none" | "outline" | "all") => {
    const border: BorderSide =
      preset === "none"
        ? { style: "none", color: lineColor }
        : { style: lineStyle === "none" ? "thin" : lineStyle, color: lineColor };

    if (preset === "none") {
      setBorderTop({ style: "none", color: "#000000" });
      setBorderRight({ style: "none", color: "#000000" });
      setBorderBottom({ style: "none", color: "#000000" });
      setBorderLeft({ style: "none", color: "#000000" });
    } else {
      setBorderTop(border);
      setBorderRight(border);
      setBorderBottom(border);
      setBorderLeft(border);
    }
  };

  const toggleBorder = (
    side: "top" | "right" | "bottom" | "left",
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
      <InfoBanner>
        Border rendering coming soon. Configure borders here for when support is added.
      </InfoBanner>

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
            <PresetButton onClick={() => applyPreset("none")} title="No borders">
              None
            </PresetButton>
            <PresetButton onClick={() => applyPreset("outline")} title="Outline borders">
              Outline
            </PresetButton>
          </PresetRow>

          {/* Border buttons */}
          <SectionTitle>Border</SectionTitle>
          <BorderButtonRow>
            <BorderToggle
              $active={borderTop.style !== "none"}
              onClick={() => toggleBorder("top", borderTop, setBorderTop)}
            >
              Top
            </BorderToggle>
            <BorderToggle
              $active={borderBottom.style !== "none"}
              onClick={() => toggleBorder("bottom", borderBottom, setBorderBottom)}
            >
              Bottom
            </BorderToggle>
            <BorderToggle
              $active={borderLeft.style !== "none"}
              onClick={() => toggleBorder("left", borderLeft, setBorderLeft)}
            >
              Left
            </BorderToggle>
            <BorderToggle
              $active={borderRight.style !== "none"}
              onClick={() => toggleBorder("right", borderRight, setBorderRight)}
            >
              Right
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
                ...{
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
                },
              }}
            >
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

const InfoBanner = styled.div`
  padding: 6px 10px;
  font-size: 11px;
  color: ${v("--text-secondary")};
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  font-style: italic;
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

  &:hover {
    border-color: ${v("--accent-primary")};
    background: ${v("--panel-bg")};
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

  &:hover {
    opacity: 0.85;
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
