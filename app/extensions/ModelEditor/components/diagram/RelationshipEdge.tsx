// FILENAME: app/extensions/ModelEditor/components/diagram/RelationshipEdge.tsx
// PURPOSE: One relationship edge in the auto-arranged diagram: an ORTHOGONAL
//          (right-angle / Manhattan) connector between two table nodes with
//          cardinality glyphs, a name label, and a double-click hit area to open
//          the edit modal. Self-relationships (fromTable === toTable) render a
//          small loop off the node's right edge. Cardinality strings are
//          Calcula's camelCase; colors inlined from diagramTheme.

import React, { memo } from "react";
import type { ModelRelationshipInfo } from "@api";
import { DIAGRAM_COLORS as C } from "./diagramTheme";
import { GRID } from "./layoutEngine";
import { edgeSides } from "./nodeGeometry";
import type { NodePos } from "./nodeGeometry";

interface RelationshipEdgeProps {
  relationship: ModelRelationshipInfo;
  fromPos: NodePos;
  toPos: NodePos;
  /** Perpendicular offset of the connection point along the FROM node's face —
   *  spreads edges that meet the same face so they don't stack. */
  fromOffset?: number;
  /** Same, for the TO node's face. */
  toOffset?: number;
  onDoubleClick?: (relationshipName: string) => void;
}

const snapBend = (v: number): number => Math.round(v / GRID) * GRID;

/** A point `dist` pixels from (px,py) toward (qx,qy). */
function along(
  px: number,
  py: number,
  qx: number,
  qy: number,
  dist: number,
): { x: number; y: number } {
  const dx = qx - px;
  const dy = qy - py;
  const len = Math.hypot(dx, dy) || 1;
  return { x: px + (dx / len) * dist, y: py + (dy / len) * dist };
}

function getConnectionPoints(from: NodePos, to: NodePos, fromOffset: number, toOffset: number) {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const { isHorizontal, fromSide, toSide } = edgeSides(from, to);

  let x1: number, y1: number, x2: number, y2: number;
  if (isHorizontal) {
    // Left/right faces — the offset moves the point up/down along the face.
    x1 = fromSide === "right" ? from.x + from.width : from.x;
    x2 = toSide === "left" ? to.x : to.x + to.width;
    y1 = fromCy + fromOffset;
    y2 = toCy + toOffset;
  } else {
    // Top/bottom faces — the offset moves the point left/right along the face.
    y1 = fromSide === "bottom" ? from.y + from.height : from.y;
    y2 = toSide === "top" ? to.y : to.y + to.height;
    x1 = fromCx + fromOffset;
    x2 = toCx + toOffset;
  }
  return { x1, y1, x2, y2, isHorizontal };
}

function cardinalityGlyphs(cardinality: string): [string, string] {
  switch (cardinality) {
    case "manyToOne":
      return ["*", "1"];
    case "oneToMany":
      return ["1", "*"];
    case "oneToOne":
      return ["1", "1"];
    case "manyToMany":
      return ["*", "*"];
    default:
      return ["", ""];
  }
}

// Geometry of the drawn connector, plus glyph/label anchor points. Split out so
// the render stays declarative and the self-loop / normal cases share it.
interface EdgeGeometry {
  d: string;
  fromGlyph: { x: number; y: number };
  toGlyph: { x: number; y: number };
  label: { x: number; y: number };
  endDot: { x: number; y: number };
}

function orthogonalGeometry(
  from: NodePos,
  to: NodePos,
  fromOffset: number,
  toOffset: number,
): EdgeGeometry {
  const { x1, y1, x2, y2, isHorizontal } = getConnectionPoints(from, to, fromOffset, toOffset);
  let d: string;
  let b1x: number, b1y: number, b2x: number, b2y: number; // the two bend corners
  let label: { x: number; y: number };
  if (isHorizontal) {
    const bx = snapBend((x1 + x2) / 2);
    b1x = bx;
    b1y = y1;
    b2x = bx;
    b2y = y2;
    d = `M ${x1} ${y1} L ${bx} ${y1} L ${bx} ${y2} L ${x2} ${y2}`;
    label = { x: bx, y: (y1 + y2) / 2 - 8 };
  } else {
    const by = snapBend((y1 + y2) / 2);
    b1x = x1;
    b1y = by;
    b2x = x2;
    b2y = by;
    d = `M ${x1} ${y1} L ${x1} ${by} L ${x2} ${by} L ${x2} ${y2}`;
    label = { x: (x1 + x2) / 2, y: by - 8 };
  }
  const fromGlyph = along(x1, y1, b1x, b1y, 16);
  const toGlyph = along(x2, y2, b2x, b2y, 16);
  return {
    d,
    fromGlyph: { x: fromGlyph.x, y: fromGlyph.y - 6 },
    toGlyph: { x: toGlyph.x, y: toGlyph.y - 6 },
    label,
    endDot: { x: x2, y: y2 },
  };
}

function selfLoopGeometry(node: NodePos): EdgeGeometry {
  const rx = node.x + node.width;
  const cy = node.y + node.height / 2;
  const ext = 24;
  const half = 16;
  const d = `M ${rx} ${cy - half} L ${rx + ext} ${cy - half} L ${rx + ext} ${cy + half} L ${rx} ${cy + half}`;
  return {
    d,
    fromGlyph: { x: rx + 8, y: cy - half - 4 },
    toGlyph: { x: rx + 8, y: cy + half + 10 },
    label: { x: rx + ext + 6, y: cy },
    endDot: { x: rx, y: cy + half },
  };
}

export const RelationshipEdge = memo(function RelationshipEdge({
  relationship,
  fromPos,
  toPos,
  fromOffset = 0,
  toOffset = 0,
  onDoubleClick,
}: RelationshipEdgeProps): React.ReactElement {
  const isSelf = fromPos.x === toPos.x && fromPos.y === toPos.y;
  const geo = isSelf
    ? selfLoopGeometry(fromPos)
    : orthogonalGeometry(fromPos, toPos, fromOffset, toOffset);

  const [fromLabel, toLabel] = cardinalityGlyphs(relationship.cardinality);
  const isActive = relationship.active;
  const strokeColor = isActive ? C.accent : C.textMuted;
  const strokeOpacity = isActive ? 0.7 : 0.35;

  const handleDbl = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick?.(relationship.name);
  };

  return (
    <g>
      <path
        d={geo.d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeDasharray={isActive ? undefined : "6 3"}
        opacity={strokeOpacity}
      />
      <circle
        cx={geo.endDot.x}
        cy={geo.endDot.y}
        r={3}
        fill={strokeColor}
        opacity={isActive ? 0.85 : 0.4}
      />
      <text
        x={geo.fromGlyph.x}
        y={geo.fromGlyph.y}
        textAnchor="middle"
        fill={strokeColor}
        fontSize={10}
        fontWeight={600}
        style={{ pointerEvents: "none" }}
      >
        {fromLabel}
      </text>
      <text
        x={geo.toGlyph.x}
        y={geo.toGlyph.y}
        textAnchor="middle"
        fill={strokeColor}
        fontSize={10}
        fontWeight={600}
        style={{ pointerEvents: "none" }}
      >
        {toLabel}
      </text>
      {/* Wider invisible hit area for double-click. */}
      <path
        d={geo.d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: onDoubleClick ? "pointer" : undefined }}
        onDoubleClick={handleDbl}
      />
      <text
        x={geo.label.x}
        y={geo.label.y}
        textAnchor="middle"
        fill={isActive ? C.textSecondary : C.textMuted}
        fontSize={9}
        fontStyle={isActive ? "normal" : "italic"}
        style={{ cursor: onDoubleClick ? "pointer" : undefined }}
        onDoubleClick={handleDbl}
      >
        {relationship.name}
        {isActive ? "" : " (inactive)"}
      </text>
    </g>
  );
}, arePropsEqual);

function samePos(a: NodePos, b: NodePos): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function arePropsEqual(prev: RelationshipEdgeProps, next: RelationshipEdgeProps): boolean {
  return (
    prev.relationship === next.relationship &&
    samePos(prev.fromPos, next.fromPos) &&
    samePos(prev.toPos, next.toPos) &&
    (prev.fromOffset ?? 0) === (next.fromOffset ?? 0) &&
    (prev.toOffset ?? 0) === (next.toOffset ?? 0) &&
    prev.onDoubleClick === next.onDoubleClick
  );
}
