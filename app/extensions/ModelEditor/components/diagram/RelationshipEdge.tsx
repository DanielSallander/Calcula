// FILENAME: app/extensions/ModelEditor/components/diagram/RelationshipEdge.tsx
// PURPOSE: One relationship edge in the diagram: a bezier between two table
//          nodes with cardinality glyphs, a name label, and a double-click hit
//          area to open the edit modal. Ported from Calcula Studio (cardinality
//          strings adapted to Calcula's camelCase, colors inlined).

import React, { memo } from "react";
import type { ModelRelationshipInfo } from "@api";
import { DIAGRAM_COLORS as C } from "./diagramTheme";

interface NodePos {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RelationshipEdgeProps {
  relationship: ModelRelationshipInfo;
  fromPos: NodePos;
  toPos: NodePos;
  /** Vertical/horizontal offset to separate parallel edges between a pair. */
  offset?: number;
  onDoubleClick?: (relationshipName: string) => void;
}

function getConnectionPoints(from: NodePos, to: NodePos, offset: number) {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;

  let x1: number, y1: number, x2: number, y2: number;
  let isHorizontal: boolean;

  if (Math.abs(fromCx - toCx) > Math.abs(fromCy - toCy)) {
    isHorizontal = true;
    if (fromCx < toCx) {
      x1 = from.x + from.width;
      x2 = to.x;
    } else {
      x1 = from.x;
      x2 = to.x + to.width;
    }
    y1 = fromCy + offset;
    y2 = toCy + offset;
  } else {
    isHorizontal = false;
    x1 = fromCx + offset;
    x2 = toCx + offset;
    if (fromCy < toCy) {
      y1 = from.y + from.height;
      y2 = to.y;
    } else {
      y1 = from.y;
      y2 = to.y + to.height;
    }
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

export const RelationshipEdge = memo(function RelationshipEdge({
  relationship,
  fromPos,
  toPos,
  offset = 0,
  onDoubleClick,
}: RelationshipEdgeProps): React.ReactElement {
  const { x1, y1, x2, y2, isHorizontal } = getConnectionPoints(fromPos, toPos, offset);
  const dx = x2 - x1;
  const cx1 = x1 + dx * 0.4;
  const cy1 = y1;
  const cx2 = x2 - dx * 0.4;
  const cy2 = y2;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const labelX = midX;
  const labelY = isHorizontal ? midY - 8 : midY - 8 + offset;

  const [fromLabel, toLabel] = cardinalityGlyphs(relationship.cardinality);
  const isActive = relationship.active;
  const strokeColor = isActive ? C.accent : C.textMuted;
  const strokeOpacity = isActive ? 0.7 : 0.35;
  const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;

  const handleDbl = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick?.(relationship.name);
  };

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeDasharray={isActive ? undefined : "6 3"}
        opacity={strokeOpacity}
      />
      <circle cx={x2} cy={y2} r={3} fill={strokeColor} opacity={isActive ? 0.85 : 0.4} />
      <text
        x={x1 + (cx1 - x1) * 0.3}
        y={y1 + (cy1 - y1) * 0.3 - 8}
        textAnchor="middle"
        fill={strokeColor}
        fontSize={10}
        fontWeight={600}
      >
        {fromLabel}
      </text>
      <text
        x={x2 - (x2 - cx2) * 0.3}
        y={y2 - (y2 - cy2) * 0.3 - 8}
        textAnchor="middle"
        fill={strokeColor}
        fontSize={10}
        fontWeight={600}
      >
        {toLabel}
      </text>
      {/* Wider invisible hit area for double-click. */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: onDoubleClick ? "pointer" : undefined }}
        onDoubleClick={handleDbl}
      />
      <text
        x={labelX}
        y={labelY}
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
    (prev.offset ?? 0) === (next.offset ?? 0) &&
    prev.onDoubleClick === next.onDoubleClick
  );
}
