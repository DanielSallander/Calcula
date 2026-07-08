// FILENAME: app/extensions/ModelEditor/components/diagram/TableNode.tsx
// PURPOSE: One table node in the relationship diagram. Sized to fit its header
//          and columns (getNodeWidth). Clicking selects the table; columns are
//          drag sources for creating relationships. In Free-float layout mode the
//          header is also a drag handle (onHeaderMouseDown), letting the user
//          reposition the node. Memoized so a re-layout re-renders only moved
//          nodes.

import React, { memo } from "react";
import type { ModelTableInfo } from "@api";
import { DIAGRAM_COLORS as C } from "./diagramTheme";
import {
  columnLabel,
  getNodeHeight,
  getNodeWidth,
  headerLabel,
  HEADER_HEIGHT,
  ROW_HEIGHT,
} from "./nodeGeometry";

export interface ColumnDragInfo {
  tableName: string;
  columnName: string;
}

interface TableNodeProps {
  table: ModelTableInfo;
  x: number;
  y: number;
  isSelected: boolean;
  // Callbacks receive the table name so parents can pass stable handlers (the
  // component is memoized — fresh closures per render would defeat it).
  onSelect: (tableName: string) => void;
  /** Free-float mode only: drag the header to reposition the node. */
  onHeaderMouseDown?: (tableName: string, e: React.MouseEvent) => void;
  onColumnDragStart?: (info: ColumnDragInfo, e: React.MouseEvent) => void;
  dragOverColumn?: ColumnDragInfo | null;
  isDragSource?: ColumnDragInfo | null;
}

export const TableNode = memo(function TableNode({
  table,
  x,
  y,
  isSelected,
  onSelect,
  onHeaderMouseDown,
  onColumnDragStart,
  dragOverColumn,
  isDragSource,
}: TableNodeProps): React.ReactElement {
  const height = getNodeHeight(table);
  const width = getNodeWidth(table);
  const isInMemory = table.storageMode === "InMemory";

  const headerFill = isSelected ? C.accent : isInMemory ? C.inMemoryHeader : C.bgSurfaceHover;
  const borderColor = isSelected ? C.accent : isInMemory ? C.inMemoryBorder : C.border;

  const headerCursor = onHeaderMouseDown ? "grab" : "pointer";
  const handleHeaderMouseDown = onHeaderMouseDown
    ? (e: React.MouseEvent) => onHeaderMouseDown(table.name, e)
    : undefined;

  return (
    <g transform={`translate(${x}, ${y})`} onClick={() => onSelect(table.name)}>
      <rect
        width={width}
        height={height}
        rx={6}
        fill={C.bgSurface}
        stroke={borderColor}
        strokeWidth={isSelected ? 2 : 1}
      />
      {/* Header — click to select the table (drag to move in Free-float mode). */}
      <rect
        width={width}
        height={HEADER_HEIGHT}
        rx={6}
        fill={headerFill}
        onMouseDown={handleHeaderMouseDown}
        style={{ cursor: headerCursor }}
      />
      <rect
        y={HEADER_HEIGHT - 6}
        width={width}
        height={6}
        fill={headerFill}
        onMouseDown={handleHeaderMouseDown}
        style={{ cursor: headerCursor }}
      />
      {isInMemory && (
        <g>
          <rect
            x={width - 30}
            y={5}
            width={22}
            height={16}
            rx={3}
            fill={isSelected ? C.bgSurface : C.inMemoryBorder}
            opacity={0.9}
          />
          <text
            x={width - 19}
            y={13}
            textAnchor="middle"
            dominantBaseline="central"
            fill={isSelected ? C.accent : "#fff"}
            fontSize={8}
            fontWeight={700}
            style={{ pointerEvents: "none" }}
          >
            IM
          </text>
        </g>
      )}
      <text
        x={10}
        y={HEADER_HEIGHT / 2}
        dominantBaseline="central"
        fill={isSelected ? "#fff" : C.textPrimary}
        fontSize={12}
        fontWeight={600}
        onMouseDown={handleHeaderMouseDown}
        style={{ cursor: headerCursor }}
      >
        {headerLabel(table, width)}
      </text>
      {/* Columns. */}
      {table.columns.length === 0 ? (
        <text
          x={10}
          y={HEADER_HEIGHT + ROW_HEIGHT / 2}
          dominantBaseline="central"
          fill={C.textMuted}
          fontSize={10}
          fontStyle="italic"
        >
          (no columns)
        </text>
      ) : (
        table.columns.map((col, i) => {
          const isOver =
            dragOverColumn?.tableName === table.name && dragOverColumn?.columnName === col.name;
          const isSource =
            isDragSource?.tableName === table.name && isDragSource?.columnName === col.name;
          return (
            <g
              key={col.name}
              transform={`translate(0, ${HEADER_HEIGHT + i * ROW_HEIGHT})`}
              onMouseDown={(e) => {
                if (onColumnDragStart) {
                  e.stopPropagation();
                  e.preventDefault();
                  onColumnDragStart({ tableName: table.name, columnName: col.name }, e);
                }
              }}
              style={{ cursor: onColumnDragStart ? "crosshair" : "default" }}
            >
              <rect x={0} y={0} width={width} height={ROW_HEIGHT} fill="transparent" />
              {(isOver || isSource) && (
                <rect
                  x={1}
                  y={0}
                  width={width - 2}
                  height={ROW_HEIGHT}
                  fill={isOver ? C.accent : C.bgSurfaceHover}
                  opacity={isOver ? 0.25 : 0.5}
                  rx={2}
                  style={{ pointerEvents: "none" }}
                />
              )}
              <text
                x={10}
                y={ROW_HEIGHT / 2}
                dominantBaseline="central"
                fill={isOver ? C.accent : C.textPrimary}
                fontSize={11}
                fontWeight={isOver ? 600 : 400}
                style={{ pointerEvents: "none" }}
              >
                {columnLabel(col, width)}
              </text>
              {col.isCalculated && (
                <text
                  x={width - 52}
                  y={ROW_HEIGHT / 2}
                  dominantBaseline="central"
                  textAnchor="end"
                  fill={C.accent}
                  fontSize={9}
                  opacity={0.7}
                  style={{ pointerEvents: "none" }}
                >
                  ƒ
                </text>
              )}
              <text
                x={width - 10}
                y={ROW_HEIGHT / 2}
                dominantBaseline="central"
                textAnchor="end"
                fill={C.textMuted}
                fontSize={9}
                fontFamily="monospace"
                style={{ pointerEvents: "none" }}
              >
                {col.dataType}
              </text>
            </g>
          );
        })
      )}
    </g>
  );
});
