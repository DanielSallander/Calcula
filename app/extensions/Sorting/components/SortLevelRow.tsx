//! FILENAME: app/extensions/Sorting/components/SortLevelRow.tsx
// PURPOSE: A single sort criterion row with Column, Sort On, and Order dropdowns.
// CONTEXT: Used within the Sort dialog to configure each sort level.

import React, { useEffect, useState, useCallback } from "react";
import type { SortLevel } from "../types";
import type { SortOn } from "../../../src/api/lib";
import { useSortStore } from "../hooks/useSortState";
import { getUniqueColorsInColumn } from "../lib/sortHelpers";
import * as S from "./SortDialog.styles";

// ============================================================================
// Props
// ============================================================================

interface SortLevelRowProps {
  level: SortLevel;
  index: number;
  isSelected: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function SortLevelRow({
  level,
  index,
  isSelected,
}: SortLevelRowProps): React.ReactElement {
  const {
    columnHeaders,
    rangeStartRow,
    rangeEndRow,
    rangeStartCol,
    hasHeaders,
    updateLevel,
    selectLevel,
  } = useSortStore();

  const [uniqueColors, setUniqueColors] = useState<string[]>([]);

  // Scan for colors when sortOn is color-based
  useEffect(() => {
    if (level.sortOn === "cellColor" || level.sortOn === "fontColor") {
      const absoluteCol = rangeStartCol + level.columnKey;
      const dataStartRow = hasHeaders ? rangeStartRow + 1 : rangeStartRow;
      getUniqueColorsInColumn(dataStartRow, rangeEndRow, absoluteCol, level.sortOn)
        .then(setUniqueColors)
        .catch(() => setUniqueColors([]));
    } else {
      setUniqueColors([]);
    }
  }, [level.sortOn, level.columnKey, rangeStartRow, rangeEndRow, rangeStartCol, hasHeaders]);

  const handleColumnChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateLevel(level.id, { columnKey: parseInt(e.target.value, 10) });
    },
    [level.id, updateLevel],
  );

  const handleSortOnChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newSortOn = e.target.value as SortOn;
      updateLevel(level.id, {
        sortOn: newSortOn,
        // Reset color when switching away from color sort
        color: undefined,
      });
    },
    [level.id, updateLevel],
  );

  const handleOrderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;

      if (level.sortOn === "cellColor" || level.sortOn === "fontColor") {
        // Value format: "color|direction" e.g. "#ff0000|top" or "#ff0000|bottom"
        const [color, direction] = value.split("|");
        updateLevel(level.id, {
          color,
          ascending: direction === "top",
        });
      } else {
        // Value is "asc" or "desc"
        updateLevel(level.id, { ascending: value === "asc" });
      }
    },
    [level.id, level.sortOn, updateLevel],
  );

  const handleClick = useCallback(() => {
    selectLevel(level.id);
  }, [level.id, selectLevel]);

  // Determine current order value for the select
  const getOrderValue = (): string => {
    if (level.sortOn === "cellColor" || level.sortOn === "fontColor") {
      const color = level.color || uniqueColors[0] || "";
      return `${color}|${level.ascending ? "top" : "bottom"}`;
    }
    return level.ascending ? "asc" : "desc";
  };

  const label = index === 0 ? "Sort by" : "Then by";

  return (
    <S.LevelRow $selected={isSelected} onClick={handleClick}>
      {/* Label */}
      <S.LevelLabel>{label}</S.LevelLabel>

      {/* Column dropdown */}
      <S.Select value={level.columnKey} onChange={handleColumnChange}>
        {columnHeaders.map((header, i) => (
          <option key={i} value={i}>
            {header}
          </option>
        ))}
      </S.Select>

      {/* Sort On dropdown */}
      <S.Select value={level.sortOn} onChange={handleSortOnChange}>
        <option value="value">Values</option>
        <option value="cellColor">Cell Color</option>
        <option value="fontColor">Font Color</option>
        <option value="icon">Conditional Formatting Icon</option>
      </S.Select>

      {/* Order dropdown */}
      <S.Select value={getOrderValue()} onChange={handleOrderChange}>
        {level.sortOn === "value" || level.sortOn === "icon" ? (
          <>
            <option value="asc">A to Z</option>
            <option value="desc">Z to A</option>
          </>
        ) : (
          // Color-based sorting: show each color with On Top / On Bottom options
          <>
            {uniqueColors.length > 0 ? (
              uniqueColors.flatMap((color) => [
                <option key={`${color}|top`} value={`${color}|top`}>
                  {color} - On Top
                </option>,
                <option key={`${color}|bottom`} value={`${color}|bottom`}>
                  {color} - On Bottom
                </option>,
              ])
            ) : (
              <>
                <option value="|top">No colors found - On Top</option>
                <option value="|bottom">No colors found - On Bottom</option>
              </>
            )}
          </>
        )}
      </S.Select>
    </S.LevelRow>
  );
}
