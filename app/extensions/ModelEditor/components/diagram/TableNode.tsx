// FILENAME: app/extensions/ModelEditor/components/diagram/TableNode.tsx
// PURPOSE: One draggable table node in the relationship diagram. Ported from
//          Calcula Studio's diagram/TableNode: header is the drag handle,
//          columns are drag sources for creating relationships. Memoized so
//          moving one table re-renders only that node.

import React, { memo } from "react";
import type { ModelTableInfo } from "@api";
import { DIAGRAM_COLORS as C } from "./diagramTheme";
import { HEADER_HEIGHT, NODE_WIDTH, ROW_HEIGHT, getNodeHeight } from "./nodeGeometry";

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
  onMouseDown: (tableName: string, e: React.MouseEvent) => void;
  onSelect: (tableName: string) => void;
  onColumnDragStart?: (info: ColumnDragInfo, e: React.MouseEvent) => void;
  dragOverColumn?: ColumnDragInfo | null;
  isDragSource?: ColumnDragInfo | null;
}

export const TableNode = memo(function TableNode({
  table,
  x,
  y,
  isSelected,
  onMouseDown,
  onSelect,
  onColumnDragStart,
  dragOverColumn,
  isDragSource,
}: TableNodeProps): React.ReactElement {
  const height = getNodeHeight(table);
  const isInMemory = table.storageMode === "InMemory";
  const handleHeaderMouseDown = (e: React.MouseEvent) => onMouseDown(table.name, e);

  const headerFill = isSelected ? C.accent : isInMemory ? C.inMemoryHeader : C.bgSurfaceHover;
  const borderColor = isSelected ? C.accent : isInMemory ? C.inMemoryBorder : C.border;

  return (
    <g transform={`translate(${x}, ${y})`} onClick={() => onSelect(table.name)}>
      <rect
        width={NODE_WIDTH}
        height={height}
        rx={6}
        fill={C.bgSurface}
        stroke={borderColor}
        strokeWidth={isSelected ? 2 : 1}
      />
      {/* Header — drag handle for moving the table. */}
      <rect
        width={NODE_WIDTH}
        height={HEADER_HEIGHT}
        rx={6}
        fill={headerFill}
        onMouseDown={handleHeaderMouseDown}
        style={{ cursor: "grab" }}
      />
      <rect
        y={HEADER_HEIGHT - 6}
        width={NODE_WIDTH}
        height={6}
        fill={headerFill}
        onMouseDown={handleHeaderMouseDown}
        style={{ cursor: "grab" }}
      />
      {isInMemory && (
        <g>
          <rect
            x={NODE_WIDTH - 30}
            y={5}
            width={22}
            height={16}
            rx={3}
            fill={isSelected ? C.bgSurface : C.inMemoryBorder}
            opacity={0.9}
          />
          <text
            x={NODE_WIDTH - 19}
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
        style={{ cursor: "grab" }}
      >
        {table.name.length > (isInMemory ? 16 : 20)
          ? table.name.slice(0, isInMemory ? 14 : 18) + ".."
          : table.name}
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
              <rect x={0} y={0} width={NODE_WIDTH} height={ROW_HEIGHT} fill="transparent" />
              {(isOver || isSource) && (
                <rect
                  x={1}
                  y={0}
                  width={NODE_WIDTH - 2}
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
                {col.name.length > 14 ? col.name.slice(0, 12) + ".." : col.name}
              </text>
              {col.isCalculated && (
                <text
                  x={NODE_WIDTH - 52}
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
                x={NODE_WIDTH - 10}
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
