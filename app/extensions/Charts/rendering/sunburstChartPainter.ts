//! FILENAME: app/extensions/Charts/rendering/sunburstChartPainter.ts
// PURPOSE: Pure Canvas 2D sunburst (multi-level donut) chart drawing.
// CONTEXT: Hierarchical data visualization using concentric rings.
//          Categories define hierarchy via a separator (default " > ").
//          e.g., "Electronics > Phones", "Electronics > Laptops", "Clothing > Shoes"
//          Inner ring = top level, outer rings = sub-categories.
//          If categories have no separator, behaves like a single-ring donut.

import type { ChartSpec, ParsedChartData, ChartLayout, BarRect, SunburstMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import {
  computeRadialLayout,
  drawChartBackground,
  drawTitle,
  drawRadialLegend,
  formatTickValue,
} from "./chartPainterUtils";

// ============================================================================
// Hierarchy Construction
// ============================================================================

interface SunburstNode {
  name: string;
  fullPath: string;
  value: number;
  children: SunburstNode[];
  depth: number;
  /** Angle start/end (computed during layout). */
  startAngle: number;
  endAngle: number;
  /** Color index (for palette lookup). */
  colorIndex: number;
}

/** Build a tree from flat category labels using a separator. */
function buildHierarchy(
  categories: string[],
  values: number[],
  separator: string,
): SunburstNode {
  const root: SunburstNode = {
    name: "root",
    fullPath: "",
    value: 0,
    children: [],
    depth: -1,
    startAngle: 0,
    endAngle: 0,
    colorIndex: 0,
  };

  let colorIdx = 0;

  for (let i = 0; i < categories.length; i++) {
    const parts = categories[i].split(separator).map((p) => p.trim()).filter((p) => p.length > 0);
    const value = Math.max(0, values[i] ?? 0);

    let current = root;
    let path = "";

    for (let d = 0; d < parts.length; d++) {
      path = path ? `${path}${separator}${parts[d]}` : parts[d];
      let child = current.children.find((c) => c.name === parts[d]);

      if (!child) {
        child = {
          name: parts[d],
          fullPath: path,
          value: 0,
          children: [],
          depth: d,
          startAngle: 0,
          endAngle: 0,
          colorIndex: d === 0 ? colorIdx++ : current.colorIndex,
        };
        current.children.push(child);
      }

      // Leaf node gets the value
      if (d === parts.length - 1) {
        child.value += value;
      }

      current = child;
    }
  }

  // Propagate values up: parent value = sum of children
  propagateValues(root);

  return root;
}

/** Recursively compute parent values from children. */
function propagateValues(node: SunburstNode): number {
  if (node.children.length === 0) {
    return node.value;
  }

  let sum = 0;
  for (const child of node.children) {
    sum += propagateValues(child);
  }

  // If node has its own value (leaf that also has children), keep the larger
  node.value = Math.max(node.value, sum);
  return node.value;
}

/** Assign angles to all nodes proportional to their value. */
function assignAngles(node: SunburstNode, startAngle: number, endAngle: number): void {
  node.startAngle = startAngle;
  node.endAngle = endAngle;

  if (node.children.length === 0 || node.value === 0) return;

  let currentAngle = startAngle;
  for (const child of node.children) {
    const fraction = child.value / node.value;
    const childEnd = currentAngle + fraction * (endAngle - startAngle);
    assignAngles(child, currentAngle, childEnd);
    currentAngle = childEnd;
  }
}

/** Collect all nodes at each depth level. */
function collectByDepth(node: SunburstNode, depth: number, result: Map<number, SunburstNode[]>): void {
  if (depth >= 0) {
    const list = result.get(depth) ?? [];
    list.push(node);
    result.set(depth, list);
  }

  for (const child of node.children) {
    collectByDepth(child, depth + 1, result);
  }
}

/** Find the maximum depth in the tree. */
function maxDepth(node: SunburstNode): number {
  if (node.children.length === 0) return node.depth;
  let max = node.depth;
  for (const child of node.children) {
    max = Math.max(max, maxDepth(child));
  }
  return max;
}

// ============================================================================
// Layout
// ============================================================================

export function computeSunburstLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  return computeRadialLayout(width, height, spec, data, theme);
}

// ============================================================================
// Main Paint Function
// ============================================================================

export function paintSunburstChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as SunburstMarkOptions;
  const showLabels = opts.showLabels ?? true;
  const labelFormat = opts.labelFormat ?? "category";
  const innerRadiusRatio = opts.innerRadiusRatio ?? 0.15;
  const padAngle = ((opts.padAngle ?? 0.5) * Math.PI) / 180;
  const separator = opts.levelSeparator ?? " > ";

  // 1. Background
  drawChartBackground(ctx, layout, theme);

  if (data.series.length === 0 || data.categories.length === 0) return;

  // Use first series' values
  const values = data.series[0].values;
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total === 0) return;

  // Build hierarchy
  const root = buildHierarchy(data.categories, values, separator);
  assignAngles(root, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);

  // Collect nodes by depth
  const byDepth = new Map<number, SunburstNode[]>();
  collectByDepth(root, -1, byDepth);

  const depth = maxDepth(root);
  const numLevels = Math.max(depth + 1, 1);

  // Compute radii
  const cx = plotArea.x + plotArea.width / 2;
  const cy = plotArea.y + plotArea.height / 2;
  const maxRadius = Math.min(plotArea.width, plotArea.height) / 2;
  const innerRadius = maxRadius * innerRadiusRatio;
  const ringWidth = (maxRadius - innerRadius) / numLevels;

  // 2. Draw arcs from innermost to outermost
  for (let d = 0; d <= depth; d++) {
    const nodes = byDepth.get(d) ?? [];
    const rInner = innerRadius + d * ringWidth;
    const rOuter = innerRadius + (d + 1) * ringWidth;

    for (const node of nodes) {
      const angSpan = node.endAngle - node.startAngle;
      if (angSpan <= 0) continue;

      const effectivePad = Math.min(padAngle, angSpan * 0.3);
      const sa = node.startAngle + effectivePad / 2;
      const ea = node.endAngle - effectivePad / 2;

      if (ea <= sa) continue;

      const color = getSeriesColor(spec.palette, node.colorIndex, null);

      // Lighten deeper levels
      const lighten = d * 0.12;
      const adjustedColor = lightenColor(color, lighten);

      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, sa, ea);
      ctx.arc(cx, cy, rInner, ea, sa, true);
      ctx.closePath();
      ctx.fillStyle = adjustedColor;
      ctx.fill();

      // Subtle border
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // 3. Labels
      if (showLabels && angSpan > 0.15) {
        const midAngle = (sa + ea) / 2;
        const labelR = (rInner + rOuter) / 2;
        const lx = cx + Math.cos(midAngle) * labelR;
        const ly = cy + Math.sin(midAngle) * labelR;

        let labelText: string;
        const percent = total > 0 ? (node.value / total) * 100 : 0;
        switch (labelFormat) {
          case "value":
            labelText = formatTickValue(node.value);
            break;
          case "percent":
            labelText = `${percent.toFixed(1)}%`;
            break;
          case "both":
            labelText = `${node.name}: ${formatTickValue(node.value)}`;
            break;
          default:
            labelText = node.name;
        }

        // Truncate if arc is too small
        const arcLen = angSpan * labelR;
        const maxChars = Math.floor(arcLen / 6);
        if (maxChars < 3) continue;
        if (labelText.length > maxChars) {
          labelText = labelText.substring(0, maxChars - 1) + "...";
        }

        const brightness = getBrightness(adjustedColor);
        ctx.fillStyle = brightness > 150 ? "#333333" : "#ffffff";
        ctx.font = `${Math.max(theme.labelFontSize - 1, 8)}px ${theme.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Rotate label to follow arc direction
        ctx.save();
        ctx.translate(lx, ly);
        let rotation = midAngle;
        // Flip text if it would be upside down
        if (rotation > Math.PI / 2 && rotation < Math.PI * 1.5) {
          rotation += Math.PI;
        }
        ctx.rotate(rotation);
        ctx.fillText(labelText, 0, 0);
        ctx.restore();
      }
    }
  }

  // 4. Title
  if (spec.title) {
    drawTitle(ctx, spec.title, layout, theme);
  }

  // 5. Legend (top-level categories)
  if (spec.legend.visible && data.categories.length > 0) {
    drawRadialLegend(ctx, data, spec, layout, theme);
  }
}

// ============================================================================
// Hit Geometry
// ============================================================================

export function computeSunburstBarRects(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): BarRect[] {
  const { plotArea } = layout;
  const opts = (spec.markOptions ?? {}) as SunburstMarkOptions;
  const innerRadiusRatio = opts.innerRadiusRatio ?? 0.15;
  const separator = opts.levelSeparator ?? " > ";
  const rects: BarRect[] = [];

  if (data.series.length === 0 || data.categories.length === 0) return rects;

  const values = data.series[0].values;
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total === 0) return rects;

  const root = buildHierarchy(data.categories, values, separator);
  assignAngles(root, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);

  const byDepth = new Map<number, SunburstNode[]>();
  collectByDepth(root, -1, byDepth);

  const depthMax = maxDepth(root);
  const numLevels = Math.max(depthMax + 1, 1);

  const cx = plotArea.x + plotArea.width / 2;
  const cy = plotArea.y + plotArea.height / 2;
  const maxR = Math.min(plotArea.width, plotArea.height) / 2;
  const innerR = maxR * innerRadiusRatio;
  const ringW = (maxR - innerR) / numLevels;

  // Flatten all nodes into rects (approximate bounding boxes)
  let idx = 0;
  for (let d = 0; d <= depthMax; d++) {
    const nodes = byDepth.get(d) ?? [];
    const rInner = innerR + d * ringW;
    const rOuter = innerR + (d + 1) * ringW;

    for (const node of nodes) {
      const midAngle = (node.startAngle + node.endAngle) / 2;
      const midR = (rInner + rOuter) / 2;
      const x = cx + Math.cos(midAngle) * midR - ringW / 2;
      const y = cy + Math.sin(midAngle) * midR - ringW / 2;

      rects.push({
        seriesIndex: idx,
        categoryIndex: idx,
        x,
        y,
        width: ringW,
        height: ringW,
        value: node.value,
        seriesName: node.name,
        categoryName: node.fullPath || node.name,
      });
      idx++;
    }
  }

  return rects;
}

// ============================================================================
// Helpers
// ============================================================================

function getBrightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/** Lighten a hex color by a fraction (0-1). */
function lightenColor(hex: string, amount: number): string {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);

  r = Math.min(255, Math.round(r + (255 - r) * amount));
  g = Math.min(255, Math.round(g + (255 - g) * amount));
  b = Math.min(255, Math.round(b + (255 - b) * amount));

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
