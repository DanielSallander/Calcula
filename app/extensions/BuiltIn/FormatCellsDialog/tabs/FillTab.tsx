//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/FillTab.tsx
// PURPOSE: Fill tab for the Format Cells dialog (solid, gradient, pattern fills).

import React from "react";
import styled from "styled-components";
import { useFormatCellsStore, type FillMode } from "../hooks/useFormatCellsState";
import { ColorPicker } from "../components/ColorPicker";
import type { PatternType, GradientDirection } from "../../../../src/core/types";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Pattern definitions for the pattern picker
// ============================================================================

const PATTERN_TYPES: { id: PatternType; label: string }[] = [
  { id: "lightGray", label: "Light Gray" },
  { id: "mediumGray", label: "Medium Gray" },
  { id: "darkGray", label: "Dark Gray" },
  { id: "gray125", label: "12.5% Gray" },
  { id: "gray0625", label: "6.25% Gray" },
  { id: "lightHorizontal", label: "Horizontal" },
  { id: "lightVertical", label: "Vertical" },
  { id: "lightDown", label: "Diagonal Down" },
  { id: "lightUp", label: "Diagonal Up" },
  { id: "lightGrid", label: "Grid" },
  { id: "lightTrellis", label: "Trellis" },
  { id: "darkHorizontal", label: "Dark Horizontal" },
  { id: "darkVertical", label: "Dark Vertical" },
  { id: "darkDown", label: "Dark Diagonal Down" },
  { id: "darkUp", label: "Dark Diagonal Up" },
  { id: "darkGrid", label: "Dark Grid" },
  { id: "darkTrellis", label: "Dark Trellis" },
];

const GRADIENT_DIRECTIONS: { id: GradientDirection; label: string; icon: string }[] = [
  { id: "horizontal", label: "Left to Right", icon: "\u2192" },
  { id: "vertical", label: "Top to Bottom", icon: "\u2193" },
  { id: "diagonalDown", label: "Diagonal Down", icon: "\u2198" },
  { id: "diagonalUp", label: "Diagonal Up", icon: "\u2197" },
  { id: "fromCenter", label: "From Center", icon: "\u25CE" },
];

const QUICK_COLORS = [
  "#ffffff", "#f8f9fa", "#f1f3f5", "#e9ecef", "#dee2e6",
  "#fff3bf", "#fff9db", "#fff0f6", "#f8f0fc", "#f3f0ff",
  "#e7f5ff", "#e3fafc", "#d3f9d8", "#ebfbee", "#fff4e6",
  "#ffe3e3", "#ffc9c9", "#ffa8a8", "#ff8787", "#ff6b6b",
  "#ffd43b", "#fcc419", "#fab005", "#f59f00", "#f08c00",
  "#69db7c", "#51cf66", "#40c057", "#37b24d", "#2f9e44",
  "#74c0fc", "#4dabf7", "#339af0", "#228be6", "#1c7ed6",
  "#b197fc", "#9775fa", "#845ef7", "#7950f2", "#7048e8",
];

// ============================================================================
// Component
// ============================================================================

export function FillTab(): React.ReactElement {
  const store = useFormatCellsStore();
  const {
    fillMode, setFillMode,
    backgroundColor, setBackgroundColor,
    gradientColor1, setGradientColor1,
    gradientColor2, setGradientColor2,
    gradientDirection, setGradientDirection,
    patternType, setPatternType,
    patternFgColor, setPatternFgColor,
    patternBgColor, setPatternBgColor,
  } = store;

  return (
    <Container>
      {/* Fill Type Selector */}
      <Section>
        <SectionTitle>Fill Type</SectionTitle>
        <FillModeBar>
          {(["none", "solid", "gradient", "pattern"] as FillMode[]).map((mode) => (
            <FillModeButton
              key={mode}
              $active={fillMode === mode}
              onClick={() => setFillMode(mode)}
            >
              {mode === "none" ? "No Fill" : mode.charAt(0).toUpperCase() + mode.slice(1)}
            </FillModeButton>
          ))}
        </FillModeBar>
      </Section>

      {/* Solid Fill */}
      {fillMode === "solid" && (
        <>
          <Section>
            <SectionTitle>Background Color</SectionTitle>
            <ColorPickerRow>
              <ColorPicker
                value={backgroundColor}
                onChange={setBackgroundColor}
                label="Color:"
              />
            </ColorPickerRow>
          </Section>
          <Section>
            <SectionTitle>Quick Colors</SectionTitle>
            <QuickColorGrid>
              {QUICK_COLORS.map((color) => (
                <QuickColorCell
                  key={color}
                  $color={color}
                  $selected={backgroundColor.toLowerCase() === color.toLowerCase()}
                  onClick={() => setBackgroundColor(color)}
                  title={color}
                />
              ))}
            </QuickColorGrid>
          </Section>
        </>
      )}

      {/* Gradient Fill */}
      {fillMode === "gradient" && (
        <>
          <Section>
            <SectionTitle>Gradient Colors</SectionTitle>
            <ColorPickerRow>
              <ColorPicker
                value={gradientColor1}
                onChange={setGradientColor1}
                label="Color 1:"
              />
              <ColorPicker
                value={gradientColor2}
                onChange={setGradientColor2}
                label="Color 2:"
              />
            </ColorPickerRow>
          </Section>
          <Section>
            <SectionTitle>Direction</SectionTitle>
            <DirectionBar>
              {GRADIENT_DIRECTIONS.map((dir) => (
                <DirectionButton
                  key={dir.id}
                  $active={gradientDirection === dir.id}
                  onClick={() => setGradientDirection(dir.id)}
                  title={dir.label}
                >
                  <DirectionIcon>{dir.icon}</DirectionIcon>
                  <DirectionLabel>{dir.label}</DirectionLabel>
                </DirectionButton>
              ))}
            </DirectionBar>
          </Section>
        </>
      )}

      {/* Pattern Fill */}
      {fillMode === "pattern" && (
        <>
          <Section>
            <SectionTitle>Pattern Colors</SectionTitle>
            <ColorPickerRow>
              <ColorPicker
                value={patternFgColor}
                onChange={setPatternFgColor}
                label="Pattern:"
              />
              <ColorPicker
                value={patternBgColor}
                onChange={setPatternBgColor}
                label="Background:"
              />
            </ColorPickerRow>
          </Section>
          <Section>
            <SectionTitle>Pattern Style</SectionTitle>
            <PatternGrid>
              {PATTERN_TYPES.map((pt) => (
                <PatternCell
                  key={pt.id}
                  $selected={patternType === pt.id}
                  onClick={() => setPatternType(pt.id)}
                  title={pt.label}
                >
                  <PatternPreviewCanvas
                    patternType={pt.id}
                    fgColor={patternFgColor}
                    bgColor={patternBgColor}
                  />
                </PatternCell>
              ))}
            </PatternGrid>
          </Section>
        </>
      )}

      {/* Preview */}
      <Section>
        <SectionTitle>Preview</SectionTitle>
        <PreviewCanvas
          fillMode={fillMode}
          backgroundColor={backgroundColor}
          gradientColor1={gradientColor1}
          gradientColor2={gradientColor2}
          gradientDirection={gradientDirection}
          patternType={patternType}
          patternFgColor={patternFgColor}
          patternBgColor={patternBgColor}
        />
      </Section>
    </Container>
  );
}

// ============================================================================
// Canvas-based Preview Components
// ============================================================================

function PreviewCanvas(props: {
  fillMode: FillMode;
  backgroundColor: string;
  gradientColor1: string;
  gradientColor2: string;
  gradientDirection: GradientDirection;
  patternType: PatternType;
  patternFgColor: string;
  patternBgColor: string;
}): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw checkerboard background to show transparency
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    switch (props.fillMode) {
      case "none":
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        break;
      case "solid":
        ctx.fillStyle = props.backgroundColor;
        ctx.fillRect(0, 0, w, h);
        break;
      case "gradient": {
        let gradient: CanvasGradient;
        switch (props.gradientDirection) {
          case "vertical":
            gradient = ctx.createLinearGradient(0, 0, 0, h);
            break;
          case "diagonalDown":
            gradient = ctx.createLinearGradient(0, 0, w, h);
            break;
          case "diagonalUp":
            gradient = ctx.createLinearGradient(0, h, w, 0);
            break;
          case "fromCenter": {
            const cx = w / 2, cy = h / 2;
            gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) / 2);
            break;
          }
          default:
            gradient = ctx.createLinearGradient(0, 0, w, 0);
        }
        gradient.addColorStop(0, props.gradientColor1);
        gradient.addColorStop(1, props.gradientColor2);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        break;
      }
      case "pattern":
        drawPatternPreview(ctx, props.patternType, props.patternFgColor, props.patternBgColor, w, h);
        break;
    }

    // Draw "Sample Text" on top
    const textColor = props.fillMode === "solid"
      ? (isLightColor(props.backgroundColor) ? "#000000" : "#ffffff")
      : props.fillMode === "pattern"
        ? (isLightColor(props.patternBgColor) ? "#000000" : "#ffffff")
        : "#000000";
    ctx.fillStyle = textColor;
    ctx.font = "14px Calibri, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Sample Text", w / 2, h / 2);
  }, [
    props.fillMode, props.backgroundColor,
    props.gradientColor1, props.gradientColor2, props.gradientDirection,
    props.patternType, props.patternFgColor, props.patternBgColor,
  ]);

  return (
    <PreviewCanvasEl ref={canvasRef} width={460} height={60} />
  );
}

function PatternPreviewCanvas(props: {
  patternType: PatternType;
  fgColor: string;
  bgColor: string;
}): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawPatternPreview(ctx, props.patternType, props.fgColor, props.bgColor, canvas.width, canvas.height);
  }, [props.patternType, props.fgColor, props.bgColor]);

  return <PatternPreviewCanvasEl ref={canvasRef} width={32} height={32} />;
}

function drawPatternPreview(
  ctx: CanvasRenderingContext2D,
  patternType: PatternType,
  fgColor: string,
  bgColor: string,
  w: number,
  h: number
): void {
  // Background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);

  // Create a small pattern tile
  const tileSize = 8;
  const offscreen = document.createElement("canvas");
  offscreen.width = tileSize;
  offscreen.height = tileSize;
  const pctx = offscreen.getContext("2d");
  if (!pctx) return;

  pctx.clearRect(0, 0, tileSize, tileSize);
  pctx.strokeStyle = fgColor;
  pctx.fillStyle = fgColor;
  pctx.lineWidth = 1;

  switch (patternType) {
    case "darkGray":
      pctx.fillRect(0, 0, tileSize, tileSize);
      pctx.clearRect(0, 0, 1, 1);
      pctx.clearRect(2, 2, 1, 1);
      pctx.clearRect(4, 0, 1, 1);
      pctx.clearRect(6, 2, 1, 1);
      pctx.clearRect(0, 4, 1, 1);
      pctx.clearRect(2, 6, 1, 1);
      pctx.clearRect(4, 4, 1, 1);
      pctx.clearRect(6, 6, 1, 1);
      break;
    case "mediumGray":
      for (let y = 0; y < tileSize; y++)
        for (let x = 0; x < tileSize; x++)
          if ((x + y) % 2 === 0) pctx.fillRect(x, y, 1, 1);
      break;
    case "lightGray":
      pctx.fillRect(0, 0, 1, 1);
      pctx.fillRect(4, 4, 1, 1);
      break;
    case "gray125":
      pctx.fillRect(0, 0, 1, 1);
      break;
    case "gray0625":
      pctx.fillRect(0, 0, 1, 1);
      break;
    case "lightHorizontal":
      pctx.fillRect(0, 0, tileSize, 1);
      break;
    case "darkHorizontal":
      pctx.fillRect(0, 0, tileSize, 2);
      pctx.fillRect(0, 4, tileSize, 2);
      break;
    case "lightVertical":
      pctx.fillRect(0, 0, 1, tileSize);
      break;
    case "darkVertical":
      pctx.fillRect(0, 0, 2, tileSize);
      pctx.fillRect(4, 0, 2, tileSize);
      break;
    case "lightDown":
      pctx.beginPath();
      pctx.moveTo(0, 0); pctx.lineTo(tileSize, tileSize);
      pctx.stroke();
      break;
    case "darkDown":
      pctx.beginPath();
      for (let i = -tileSize; i < tileSize * 2; i += 4) {
        pctx.moveTo(i, 0); pctx.lineTo(i + tileSize, tileSize);
        pctx.moveTo(i + 1, 0); pctx.lineTo(i + tileSize + 1, tileSize);
      }
      pctx.stroke();
      break;
    case "lightUp":
      pctx.beginPath();
      pctx.moveTo(0, tileSize); pctx.lineTo(tileSize, 0);
      pctx.stroke();
      break;
    case "darkUp":
      pctx.beginPath();
      for (let i = -tileSize; i < tileSize * 2; i += 4) {
        pctx.moveTo(i, tileSize); pctx.lineTo(i + tileSize, 0);
        pctx.moveTo(i + 1, tileSize); pctx.lineTo(i + tileSize + 1, 0);
      }
      pctx.stroke();
      break;
    case "lightGrid":
      pctx.fillRect(0, 0, tileSize, 1);
      pctx.fillRect(0, 0, 1, tileSize);
      break;
    case "darkGrid":
      pctx.fillRect(0, 0, tileSize, 2);
      pctx.fillRect(0, 4, tileSize, 2);
      pctx.fillRect(0, 0, 2, tileSize);
      pctx.fillRect(4, 0, 2, tileSize);
      break;
    case "lightTrellis":
      pctx.beginPath();
      pctx.moveTo(0, 0); pctx.lineTo(tileSize, tileSize);
      pctx.moveTo(0, tileSize); pctx.lineTo(tileSize, 0);
      pctx.stroke();
      break;
    case "darkTrellis":
      pctx.beginPath();
      for (let i = -tileSize; i < tileSize * 2; i += 4) {
        pctx.moveTo(i, 0); pctx.lineTo(i + tileSize, tileSize);
        pctx.moveTo(i, tileSize); pctx.lineTo(i + tileSize, 0);
      }
      pctx.stroke();
      break;
  }

  const pattern = ctx.createPattern(offscreen, "repeat");
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  }
}

function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "");
  if (c.length !== 6) return true;
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

// ============================================================================
// Styled Components
// ============================================================================

const Container = styled.div`
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
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

const ColorPickerRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const FillModeBar = styled.div`
  display: flex;
  gap: 2px;
  background: ${v("--bg-secondary")};
  border-radius: 6px;
  padding: 2px;
`;

const FillModeButton = styled.button<{ $active: boolean }>`
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: ${(p) => (p.$active ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$active ? "#ffffff" : v("--text-primary"))};
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  transition: all 0.15s ease;

  &:hover {
    background: ${(p) => (p.$active ? v("--accent-primary") : v("--bg-hover"))};
  }
`;

const QuickColorGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 3px;
`;

const QuickColorCell = styled.button<{ $color: string; $selected: boolean }>`
  width: 100%;
  aspect-ratio: 1;
  min-width: 20px;
  border: ${(p) =>
    p.$selected
      ? `2px solid ${v("--accent-primary")}`
      : `1px solid ${v("--border-default")}`};
  border-radius: 3px;
  background-color: ${(p) => p.$color};
  cursor: pointer;
  padding: 0;

  &:hover {
    border: 2px solid ${v("--text-primary")};
    transform: scale(1.1);
  }
`;

const DirectionBar = styled.div`
  display: flex;
  gap: 4px;
`;

const DirectionButton = styled.button<{ $active: boolean }>`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  border: 1px solid ${(p) => (p.$active ? v("--accent-primary") : v("--border-default"))};
  border-radius: 4px;
  background: ${(p) => (p.$active ? "rgba(68, 114, 196, 0.1)" : v("--grid-bg"))};
  color: ${v("--text-primary")};
  cursor: pointer;
  font-size: 11px;

  &:hover {
    border-color: ${v("--accent-primary")};
  }
`;

const DirectionIcon = styled.span`
  font-size: 16px;
`;

const DirectionLabel = styled.span`
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
`;

const PatternGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
`;

const PatternCell = styled.button<{ $selected: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: ${(p) =>
    p.$selected
      ? `2px solid ${v("--accent-primary")}`
      : `1px solid ${v("--border-default")}`};
  border-radius: 3px;
  background: ${v("--grid-bg")};
  cursor: pointer;
  aspect-ratio: 1;

  &:hover {
    border-color: ${v("--accent-primary")};
  }
`;

const PatternPreviewCanvasEl = styled.canvas`
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
`;

const PreviewCanvasEl = styled.canvas`
  width: 100%;
  height: 60px;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
`;
