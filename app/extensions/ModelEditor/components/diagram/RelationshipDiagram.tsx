// FILENAME: app/extensions/ModelEditor/components/diagram/RelationshipDiagram.tsx
// PURPOSE: Draggable SVG relationship diagram. Ported from Calcula Studio's
//          ModelDiagram: auto-layout on table changes, drag to reposition
//          nodes, drag a column onto another column to create a relationship,
//          double-click an edge to edit it. Node positions are transient (NOT
//          part of the model file) — persisted per-connection in localStorage.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRelationshipInfo, ModelTableInfo } from "@api";
import { DIAGRAM_COLORS as C } from "./diagramTheme";
import { getNodeHeight, getNodeWidth, HEADER_HEIGHT, ROW_HEIGHT } from "./nodeGeometry";
import { TableNode } from "./TableNode";
import type { ColumnDragInfo } from "./TableNode";
import { RelationshipEdge } from "./RelationshipEdge";

interface Position {
  x: number;
  y: number;
}

export interface ColumnDropResult {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface RelationshipDiagramProps {
  tables: ModelTableInfo[];
  relationships: ModelRelationshipInfo[];
  selectedTable: string | null;
  onSelectTable: (name: string | null) => void;
  onColumnDrop?: (result: ColumnDropResult) => void;
  onEditRelationship?: (relationshipName: string) => void;
  /** Per-connection layout key (localStorage). */
  layoutKey?: string | null;
}

function autoLayout(tables: ModelTableInfo[]): Record<string, Position> {
  const positions: Record<string, Position> = {};
  const cols = Math.max(Math.ceil(Math.sqrt(tables.length)), 1);
  const colWidth = getNodeWidth() + 60;
  const rowGap = 40;
  tables.forEach((table, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const rowHeight =
      Math.max(...tables.slice(row * cols, row * cols + cols).map((t) => getNodeHeight(t))) + rowGap;
    positions[table.name] = { x: 40 + col * colWidth, y: 40 + row * rowHeight };
  });
  return positions;
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
  const nodeWidth = getNodeWidth();
  for (const table of tables) {
    if (excludeTable && table.name === excludeTable) continue;
    const pos = positions[table.name];
    if (!pos) continue;
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
  const nodeWidth = getNodeWidth();
  const cy = pos.y + HEADER_HEIGHT + colIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const cx = targetX > pos.x + nodeWidth / 2 ? pos.x + nodeWidth : pos.x;
  return { x: cx, y: cy };
}

const EDGE_OFFSET_STEP = 18;

function tablePairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function RelationshipDiagram({
  tables,
  relationships,
  selectedTable,
  onSelectTable,
  onColumnDrop,
  onEditRelationship,
  layoutKey,
}: RelationshipDiagramProps): React.ReactElement {
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<Position>({ x: 0, y: 0 });
  const [columnDrag, setColumnDrag] = useState<ColumnDragState | null>(null);
  const [hoverColumn, setHoverColumn] = useState<ColumnDragInfo | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const prevTablesRef = useRef<string>("");
  const layoutKeyRef = useRef<string | null | undefined>(undefined);

  const storageKey = layoutKey ? `calcula-diagram-layout:${layoutKey}` : null;

  // Load saved positions when the layout key (connection) changes.
  useEffect(() => {
    if (layoutKeyRef.current === layoutKey) return;
    layoutKeyRef.current = layoutKey;
    if (!storageKey) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        // Legitimate external-system sync: seed draggable layout from
        // localStorage when the connection changes.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPositions(JSON.parse(saved) as Record<string, Position>);
        prevTablesRef.current = tables
          .map((t) => t.name)
          .sort()
          .join(",");
      }
    } catch {
      // ignore corrupt data
    }
  }, [storageKey, tables, layoutKey]);

  // Keep a ref to the latest positions so the stable drag callbacks read the
  // current value without being recreated (updated in an effect, never during
  // render).
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  });

  // Persist positions (debounced).
  useEffect(() => {
    if (!storageKey || Object.keys(positions).length === 0) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(positions));
      } catch {
        // storage full/unavailable
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [positions, storageKey]);

  // Auto-layout on table add/remove.
  useEffect(() => {
    const tableKey = tables
      .map((t) => t.name)
      .sort()
      .join(",");
    if (tableKey === prevTablesRef.current) return;
    prevTablesRef.current = tableKey;
    // Legitimate derived-then-user-owned state: seed positions for added
    // tables / drop removed ones; the user then drags them freely.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPositions((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!tables.find((t) => t.name === key)) delete next[key];
      }
      const existing = new Set(Object.keys(next));
      const newTables = tables.filter((t) => !existing.has(t.name));
      if (newTables.length > 0) {
        const newPositions = autoLayout(newTables);
        const maxY = Math.max(0, ...Object.values(next).map((p) => p.y + 200));
        for (const [name, pos] of Object.entries(newPositions)) {
          if (!next[name]) next[name] = { x: pos.x, y: existing.size > 0 ? pos.y + maxY : pos.y };
        }
      }
      return next;
    });
  }, [tables]);

  const svgPoint = useCallback((e: React.MouseEvent | MouseEvent): Position => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: svgPt.x, y: svgPt.y };
  }, []);

  const handleMouseDown = useCallback(
    (tableName: string, e: React.MouseEvent) => {
      e.preventDefault();
      const pos = positionsRef.current[tableName] || { x: 0, y: 0 };
      const svgPt = svgPoint(e);
      setDragging(tableName);
      setDragOffset({ x: svgPt.x - pos.x, y: svgPt.y - pos.y });
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
      if (columnDrag) {
        const pt = svgPoint(e);
        setColumnDrag((prev) => (prev ? { ...prev, mouseX: pt.x, mouseY: pt.y } : null));
        setHoverColumn(hitTestColumn(pt.x, pt.y, tables, positions, columnDrag.source.tableName));
        return;
      }
      if (!dragging) return;
      const svgPt = svgPoint(e);
      setPositions((prev) => ({
        ...prev,
        [dragging]: { x: svgPt.x - dragOffset.x, y: svgPt.y - dragOffset.y },
      }));
    },
    [dragging, dragOffset, columnDrag, svgPoint, tables, positions],
  );

  const columnDragRef = useRef(columnDrag);
  useEffect(() => {
    columnDragRef.current = columnDrag;
  });
  const handleSelectTable = useCallback(
    (tableName: string) => {
      if (!columnDragRef.current) onSelectTable(tableName);
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

  const nodeWidth = getNodeWidth();

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

  // Group parallel edges by table pair to fan them out.
  const pairGroups = new Map<string, ModelRelationshipInfo[]>();
  for (const rel of relationships) {
    const key = tablePairKey(rel.fromTable, rel.toTable);
    const group = pairGroups.get(key) ?? [];
    group.push(rel);
    pairGroups.set(key, group);
  }
  const renderList: { rel: ModelRelationshipInfo; offset: number }[] = [];
  for (const group of pairGroups.values()) {
    const sorted = [...group].sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      const offset = sorted.length === 1 ? 0 : (i - (sorted.length - 1) / 2) * EDGE_OFFSET_STEP;
      renderList.push({ rel: sorted[i], offset });
    }
  }
  renderList.sort((a, b) => (a.rel.active === b.rel.active ? 0 : a.rel.active ? 1 : -1));

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      style={{
        background: C.bgPrimary,
        cursor: columnDrag ? "crosshair" : dragging ? "grabbing" : "default",
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
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke={C.border} strokeWidth="0.5" opacity="0.4" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#me-diagram-grid)" />

      {renderList.map(({ rel, offset }) => {
        const fromPos = positions[rel.fromTable];
        const toPos = positions[rel.toTable];
        const fromTable = tables.find((t) => t.name === rel.fromTable);
        const toTable = tables.find((t) => t.name === rel.toTable);
        if (!fromPos || !toPos || !fromTable || !toTable) return null;
        return (
          <RelationshipEdge
            key={rel.name}
            relationship={rel}
            fromPos={{ ...fromPos, width: nodeWidth, height: getNodeHeight(fromTable) }}
            toPos={{ ...toPos, width: nodeWidth, height: getNodeHeight(toTable) }}
            offset={offset}
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
            onMouseDown={handleMouseDown}
            onSelect={handleSelectTable}
            onColumnDragStart={handleColumnDragStart}
            dragOverColumn={hoverColumn?.tableName === table.name ? hoverColumn : null}
            isDragSource={columnDrag?.source.tableName === table.name ? columnDrag.source : null}
          />
        );
      })}

      {tables.length === 0 && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill={C.textMuted}
          fontSize={14}
        >
          No tables in model. Add tables in the Tables section first.
        </text>
      )}
    </svg>
  );
}
