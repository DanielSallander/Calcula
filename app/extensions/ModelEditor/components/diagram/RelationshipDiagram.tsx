// FILENAME: app/extensions/ModelEditor/components/diagram/RelationshipDiagram.tsx
// PURPOSE: SVG relationship diagram. In "auto"/"radial"/"layered" modes the node
//          positions are COMPUTED from the tables + relationships graph (a pure
//          computeLayout in a useMemo) so the same model always draws the same
//          shape. In "free" mode the user drags nodes freely; free-float SEEDS
//          from whatever computed layout was showing when the mode was selected
//          (so switching Radial → Free starts from the radial arrangement), then
//          the positions are user-owned. Interactions in every mode: drag a
//          column onto another table's column to create a relationship,
//          double-click an edge to edit it, click a node to select it. A zoom
//          slider + Fit control sit in the lower-right corner.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelRelationshipInfo, ModelTableInfo } from "@api";
import { DIAGRAM_COLORS as C } from "./diagramTheme";
import { edgeSides, getNodeHeight, getNodeWidth, HEADER_HEIGHT, ROW_HEIGHT } from "./nodeGeometry";
import type { EdgeSide, NodePos } from "./nodeGeometry";
import { computeLayout } from "./layoutEngine";
import type { LayoutMode, Position } from "./layoutEngine";
import { TableNode } from "./TableNode";
import type { ColumnDragInfo } from "./TableNode";
import { RelationshipEdge } from "./RelationshipEdge";

export interface ColumnDropResult {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/** UI layout modes: the three computed layouts plus manual "free" positioning. */
export type DiagramLayoutMode = LayoutMode | "free";

interface RelationshipDiagramProps {
  tables: ModelTableInfo[];
  relationships: ModelRelationshipInfo[];
  selectedTable: string | null;
  onSelectTable: (name: string | null) => void;
  onColumnDrop?: (result: ColumnDropResult) => void;
  onEditRelationship?: (relationshipName: string) => void;
  /** "auto" (default) picks radial for stars, layered otherwise; "free" = drag. */
  layoutMode?: DiagramLayoutMode;
}

interface ColumnDragState {
  source: ColumnDragInfo;
  mouseX: number;
  mouseY: number;
}

function hitTestColumn(
  svgX: number,
  svgY: number,
  tables: ModelTableInfo[],
  positions: Record<string, Position>,
  excludeTable?: string,
): ColumnDragInfo | null {
  for (const table of tables) {
    if (excludeTable && table.name === excludeTable) continue;
    const pos = positions[table.name];
    if (!pos) continue;
    const nodeWidth = getNodeWidth(table);
    if (
      svgX >= pos.x &&
      svgX <= pos.x + nodeWidth &&
      svgY >= pos.y + HEADER_HEIGHT &&
      svgY <= pos.y + HEADER_HEIGHT + table.columns.length * ROW_HEIGHT
    ) {
      const colIndex = Math.floor((svgY - pos.y - HEADER_HEIGHT) / ROW_HEIGHT);
      if (colIndex >= 0 && colIndex < table.columns.length) {
        return { tableName: table.name, columnName: table.columns[colIndex].name };
      }
    }
  }
  return null;
}

function getColumnEdgePoint(
  tableName: string,
  columnName: string,
  tables: ModelTableInfo[],
  positions: Record<string, Position>,
  targetX: number,
): Position | null {
  const table = tables.find((t) => t.name === tableName);
  const pos = positions[tableName];
  if (!table || !pos) return null;
  const colIndex = table.columns.findIndex((c) => c.name === columnName);
  if (colIndex < 0) return null;
  const nodeWidth = getNodeWidth(table);
  const cy = pos.y + HEADER_HEIGHT + colIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const cx = targetX > pos.x + nodeWidth / 2 ? pos.x + nodeWidth : pos.x;
  return { x: cx, y: cy };
}

const CANVAS_PAD = 40;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const EDGE_GAP = 12; // gap between edges that meet the same node face
const EDGE_FACE_MARGIN = 16; // keep spread points away from a face's corners

export function RelationshipDiagram({
  tables,
  relationships,
  selectedTable,
  onSelectTable,
  onColumnDrop,
  onEditRelationship,
  layoutMode = "auto",
}: RelationshipDiagramProps): React.ReactElement {
  const [columnDrag, setColumnDrag] = useState<ColumnDragState | null>(null);
  const [hoverColumn, setHoverColumn] = useState<ColumnDragInfo | null>(null);
  const [scale, setScale] = useState(1);
  // Free-float mode only: user-owned node positions + the node being dragged.
  const [freePositions, setFreePositions] = useState<Record<string, Position> | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<Position>({ x: 0, y: 0 });

  const isFree = layoutMode === "free";

  // Remember the last *computed* mode so entering Free seeds from it (Radial →
  // Free starts from the radial arrangement, not from a fresh auto layout).
  const [lastComputedMode, setLastComputedMode] = useState<LayoutMode>(
    layoutMode === "free" ? "auto" : layoutMode,
  );
  const baseMode: LayoutMode = isFree ? lastComputedMode : layoutMode;

  // The computed layout (pure function of the graph + base mode).
  const computed = useMemo(
    () => computeLayout(tables, relationships, baseMode),
    [tables, relationships, baseMode],
  );

  // Adjust derived state when the layout mode changes — the React-sanctioned
  // "adjusting state while rendering" pattern (cheaper + no effect churn than a
  // useEffect). Entering Free seeds free positions from the layout that was just
  // showing; leaving Free clears them so the next entry re-seeds.
  const [prevLayoutMode, setPrevLayoutMode] = useState<DiagramLayoutMode>(layoutMode);
  if (layoutMode !== prevLayoutMode) {
    setPrevLayoutMode(layoutMode);
    if (layoutMode === "free") {
      setFreePositions(computed);
    } else {
      setLastComputedMode(layoutMode);
      setFreePositions(null);
    }
  }

  // Effective positions: the computed layout, overlaid in Free mode with the
  // user's dragged positions (a newly added table still gets a computed spot).
  const positions = useMemo(
    () => (isFree ? { ...computed, ...(freePositions ?? {}) } : computed),
    [isFree, computed, freePositions],
  );

  // Content bounds → SVG size, so the enclosing overflow:auto card scrolls when
  // the schema is larger than the viewport.
  const canvas = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const t of tables) {
      const p = positions[t.name];
      if (!p) continue;
      maxX = Math.max(maxX, p.x + getNodeWidth(t));
      maxY = Math.max(maxY, p.y + getNodeHeight(t));
    }
    return { w: Math.max(maxX + CANVAS_PAD, 400), h: Math.max(maxY + CANVAS_PAD, 300) };
  }, [positions, tables]);

  // Latest positions, for the stable drag handlers to read without recreating.
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  });

  const svgPoint = useCallback((e: React.MouseEvent | MouseEvent): Position => {
    const svg = svgRef.current;
    const g = contentRef.current;
    if (!svg || !g) return { x: 0, y: 0 };
    const ctm = g.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    // Map through the scaled content group's CTM so positions come back in the
    // unscaled layout coordinate system regardless of zoom.
    const svgPt = pt.matrixTransform(ctm.inverse());
    return { x: svgPt.x, y: svgPt.y };
  }, []);

  // Distinguishes a header click (select) from a header drag (move) in Free mode.
  const didDragRef = useRef(false);

  const handleHeaderMouseDown = useCallback(
    (tableName: string, e: React.MouseEvent) => {
      e.preventDefault();
      const p = positionsRef.current[tableName] ?? { x: 0, y: 0 };
      const pt = svgPoint(e);
      dragOffsetRef.current = { x: pt.x - p.x, y: pt.y - p.y };
      didDragRef.current = false;
      setDragging(tableName);
    },
    [svgPoint],
  );

  const handleColumnDragStart = useCallback(
    (info: ColumnDragInfo, e: React.MouseEvent) => {
      const pt = svgPoint(e);
      setColumnDrag({ source: info, mouseX: pt.x, mouseY: pt.y });
      setHoverColumn(null);
    },
    [svgPoint],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) {
        const pt = svgPoint(e);
        const off = dragOffsetRef.current;
        const next = { x: pt.x - off.x, y: pt.y - off.y };
        didDragRef.current = true;
        setFreePositions((prev) => ({ ...(prev ?? positionsRef.current), [dragging]: next }));
        return;
      }
      if (!columnDrag) return;
      const pt = svgPoint(e);
      setColumnDrag((prev) => (prev ? { ...prev, mouseX: pt.x, mouseY: pt.y } : null));
      setHoverColumn(hitTestColumn(pt.x, pt.y, tables, positions, columnDrag.source.tableName));
    },
    [dragging, columnDrag, svgPoint, tables, positions],
  );

  // Keep a ref to the latest column-drag so the stable select handler can tell
  // "click to select" apart from "dropped a column here" / "dragged a node".
  const columnDragRef = useRef(columnDrag);
  useEffect(() => {
    columnDragRef.current = columnDrag;
  });
  const handleSelectTable = useCallback(
    (tableName: string) => {
      if (!columnDragRef.current && !didDragRef.current) onSelectTable(tableName);
    },
    [onSelectTable],
  );

  const handleMouseUp = useCallback(() => {
    if (columnDrag && hoverColumn) {
      onColumnDrop?.({
        fromTable: columnDrag.source.tableName,
        fromColumn: columnDrag.source.columnName,
        toTable: hoverColumn.tableName,
        toColumn: hoverColumn.columnName,
      });
    }
    setColumnDrag(null);
    setHoverColumn(null);
    setDragging(null);
  }, [columnDrag, hoverColumn, onColumnDrop]);

  let dragLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (columnDrag) {
    const sourcePoint = getColumnEdgePoint(
      columnDrag.source.tableName,
      columnDrag.source.columnName,
      tables,
      positions,
      columnDrag.mouseX,
    );
    if (sourcePoint) {
      if (hoverColumn) {
        const targetPoint = getColumnEdgePoint(
          hoverColumn.tableName,
          hoverColumn.columnName,
          tables,
          positions,
          sourcePoint.x,
        );
        if (targetPoint) {
          dragLine = { x1: sourcePoint.x, y1: sourcePoint.y, x2: targetPoint.x, y2: targetPoint.y };
        }
      }
      if (!dragLine) {
        dragLine = {
          x1: sourcePoint.x,
          y1: sourcePoint.y,
          x2: columnDrag.mouseX,
          y2: columnDrag.mouseY,
        };
      }
    }
  }

  // Resolve each edge's node rectangles + which face it meets, then spread the
  // connection points of every edge that meets the same face (e.g. several
  // tables all pointing at one dimension) so they sit next to each other with a
  // small gap instead of stacking on the same point.
  interface EdgeInfo {
    rel: ModelRelationshipInfo;
    from: NodePos;
    to: NodePos;
    isSelf: boolean;
    fromSide: EdgeSide | null;
    toSide: EdgeSide | null;
  }
  const edgeInfos: EdgeInfo[] = [];
  for (const rel of relationships) {
    const fromPos = positions[rel.fromTable];
    const toPos = positions[rel.toTable];
    const fromTable = tables.find((t) => t.name === rel.fromTable);
    const toTable = tables.find((t) => t.name === rel.toTable);
    if (!fromPos || !toPos || !fromTable || !toTable) continue;
    const from = { ...fromPos, width: getNodeWidth(fromTable), height: getNodeHeight(fromTable) };
    const to = { ...toPos, width: getNodeWidth(toTable), height: getNodeHeight(toTable) };
    const isSelf = rel.fromTable === rel.toTable;
    const sides = isSelf ? null : edgeSides(from, to);
    edgeInfos.push({
      rel,
      from,
      to,
      isSelf,
      fromSide: sides?.fromSide ?? null,
      toSide: sides?.toSide ?? null,
    });
  }

  const fromOffsets = new Array<number>(edgeInfos.length).fill(0);
  const toOffsets = new Array<number>(edgeInfos.length).fill(0);
  interface Endpoint {
    edge: number;
    end: "from" | "to";
    side: EdgeSide;
  }
  const faceGroups = new Map<string, Endpoint[]>();
  edgeInfos.forEach((e, i) => {
    if (e.fromSide) {
      const key = `${e.rel.fromTable}|${e.fromSide}`;
      const g = faceGroups.get(key) ?? [];
      g.push({ edge: i, end: "from", side: e.fromSide });
      faceGroups.set(key, g);
    }
    if (e.toSide) {
      const key = `${e.rel.toTable}|${e.toSide}`;
      const g = faceGroups.get(key) ?? [];
      g.push({ edge: i, end: "to", side: e.toSide });
      faceGroups.set(key, g);
    }
  });
  for (const eps of faceGroups.values()) {
    if (eps.length <= 1) continue;
    const vertical = eps[0].side === "left" || eps[0].side === "right";
    const otherCenter = (ep: Endpoint): number => {
      const e = edgeInfos[ep.edge];
      const other = ep.end === "from" ? e.to : e.from;
      return vertical ? other.y + other.height / 2 : other.x + other.width / 2;
    };
    // Order along the face by the opposite endpoint's position (fewer crossings).
    const sorted = [...eps].sort((a, b) => otherCenter(a) - otherCenter(b));
    const n = sorted.length;
    const faceExtent = Math.min(
      ...sorted.map((ep) => {
        const node = ep.end === "from" ? edgeInfos[ep.edge].from : edgeInfos[ep.edge].to;
        return vertical ? node.height : node.width;
      }),
    );
    const step = Math.min(EDGE_GAP, Math.max(0, faceExtent - EDGE_FACE_MARGIN * 2) / (n - 1));
    sorted.forEach((ep, idx) => {
      const off = (idx - (n - 1) / 2) * step;
      if (ep.end === "from") fromOffsets[ep.edge] = off;
      else toOffsets[ep.edge] = off;
    });
  }

  // Draw inactive edges first so active ones sit on top.
  const renderOrder = edgeInfos
    .map((_, i) => i)
    .sort((a, b) =>
      edgeInfos[a].rel.active === edgeInfos[b].rel.active ? 0 : edgeInfos[a].rel.active ? 1 : -1,
    );

  const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  // Fit the whole diagram into the visible viewport (never zoom past 1:1).
  const handleFit = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const fit = Math.min(el.clientWidth / canvas.w, el.clientHeight / canvas.h, 1);
    setScale(Math.max(MIN_SCALE, fit));
  }, [canvas.w, canvas.h]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <div ref={scrollerRef} style={{ width: "100%", height: "100%", overflow: "auto" }}>
        <svg
          ref={svgRef}
          width={canvas.w * scale}
          height={canvas.h * scale}
          style={{
            background: C.bgPrimary,
            cursor: columnDrag ? "crosshair" : dragging ? "grabbing" : "default",
            display: "block",
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={() => {
            if (!columnDrag) onSelectTable(null);
          }}
        >
          <defs>
            <pattern id="me-diagram-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke={C.border}
                strokeWidth="0.5"
                opacity="0.4"
              />
            </pattern>
          </defs>
          <g ref={contentRef} transform={`scale(${scale})`}>
            <rect width={canvas.w} height={canvas.h} fill="url(#me-diagram-grid)" />

            {renderOrder.map((i) => {
              const e = edgeInfos[i];
              return (
                <RelationshipEdge
                  key={e.rel.name}
                  relationship={e.rel}
                  fromPos={e.from}
                  toPos={e.to}
                  fromOffset={fromOffsets[i]}
                  toOffset={toOffsets[i]}
                  onDoubleClick={onEditRelationship}
                />
              );
            })}

            {dragLine && (
              <g>
                <line
                  x1={dragLine.x1}
                  y1={dragLine.y1}
                  x2={dragLine.x2}
                  y2={dragLine.y2}
                  stroke={C.accent}
                  strokeWidth={2}
                  strokeDasharray={hoverColumn ? "none" : "6 3"}
                  opacity={0.8}
                />
                <circle cx={dragLine.x1} cy={dragLine.y1} r={4} fill={C.accent} />
                <circle
                  cx={dragLine.x2}
                  cy={dragLine.y2}
                  r={hoverColumn ? 4 : 3}
                  fill={hoverColumn ? C.accent : C.textMuted}
                />
              </g>
            )}

            {tables.map((table) => {
              const pos = positions[table.name] || { x: 0, y: 0 };
              return (
                <TableNode
                  key={table.name}
                  table={table}
                  x={pos.x}
                  y={pos.y}
                  isSelected={selectedTable === table.name}
                  onSelect={handleSelectTable}
                  onHeaderMouseDown={isFree ? handleHeaderMouseDown : undefined}
                  onColumnDragStart={handleColumnDragStart}
                  dragOverColumn={hoverColumn?.tableName === table.name ? hoverColumn : null}
                  isDragSource={
                    columnDrag?.source.tableName === table.name ? columnDrag.source : null
                  }
                />
              );
            })}

            {tables.length === 0 && (
              <text
                x={canvas.w / 2}
                y={canvas.h / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill={C.textMuted}
                fontSize={14}
              >
                No tables in model. Add tables in the Tables section first.
              </text>
            )}
          </g>
        </svg>
      </div>

      {tables.length > 0 && (
        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: C.bgSurface,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "4px 8px",
            boxShadow: "0 1px 4px rgba(0,0,0,0.14)",
            userSelect: "none",
          }}
        >
          <button
            type="button"
            title="Zoom out"
            style={zoomButtonStyle}
            onClick={() => setScale((s) => clampScale(s - 0.1))}
          >
            −
          </button>
          <input
            type="range"
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={0.05}
            value={scale}
            aria-label="Zoom"
            onChange={(e) => setScale(clampScale(parseFloat(e.target.value)))}
            style={{ width: 100, accentColor: C.accent }}
          />
          <button
            type="button"
            title="Zoom in"
            style={zoomButtonStyle}
            onClick={() => setScale((s) => clampScale(s + 0.1))}
          >
            +
          </button>
          <span style={{ fontSize: 11, color: C.textSecondary, width: 36, textAlign: "right" }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            title="Fit diagram to view"
            style={zoomFitStyle}
            onClick={handleFit}
          >
            Fit
          </button>
        </div>
      )}
    </div>
  );
}

const zoomButtonStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  lineHeight: "20px",
  padding: 0,
  fontSize: 15,
  fontWeight: 600,
  color: C.textPrimary,
  background: C.bgSurface,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  cursor: "pointer",
};

const zoomFitStyle: React.CSSProperties = {
  height: 22,
  padding: "0 8px",
  fontSize: 11,
  fontWeight: 600,
  color: C.textPrimary,
  background: C.bgSurface,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  cursor: "pointer",
};
