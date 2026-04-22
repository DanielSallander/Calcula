//! FILENAME: app/extensions/Sorting/components/SortLevelRow.tsx
// PURPOSE: A single sort criterion row with Column, Sort On, and Order dropdowns.
// CONTEXT: Used within the Sort dialog to configure each sort level.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import type { SortLevel } from "../types";
import type { SortOn } from "@api/lib";
import { FillListRegistry, type FillList } from "@api";
import { useSortStore } from "../hooks/useSortState";
import { getUniqueColorsInColumn } from "../lib/sortHelpers";
import * as S from "./SortDialog.styles";

// ============================================================================
// Constants
// ============================================================================

/** Built-in custom sort list identifiers mapped to their display names */
const BUILTIN_SORT_LISTS: { id: string; label: string }[] = [
  { id: "weekdays", label: "Sun, Mon, Tue, ... (Weekdays)" },
  { id: "weekdaysShort", label: "Sun, Mon, Tue, ... (Short)" },
  { id: "months", label: "Jan, Feb, Mar, ... (Months)" },
  { id: "monthsShort", label: "Jan, Feb, Mar, ... (Short)" },
];

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
  const [userLists, setUserLists] = useState<FillList[]>([]);

  // Load user-defined custom fill lists
  useEffect(() => {
    setUserLists(FillListRegistry.getUserLists());
    const unsub = FillListRegistry.subscribe(() => {
      setUserLists(FillListRegistry.getUserLists());
    });
    return unsub;
  }, []);

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
        // Reset color and custom order when switching sort-on type
        color: undefined,
        customOrder: undefined,
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
          customOrder: undefined,
        });
      } else if (value.startsWith("custom:")) {
        // Custom list selection: "custom:<listId>"
        const listId = value.slice(7);
        updateLevel(level.id, {
          ascending: true,
          customOrder: listId,
        });
      } else if (value.startsWith("customDesc:")) {
        // Custom list descending: "customDesc:<listId>"
        const listId = value.slice(11);
        updateLevel(level.id, {
          ascending: false,
          customOrder: listId,
        });
      } else {
        // Value is "asc" or "desc"
        updateLevel(level.id, {
          ascending: value === "asc",
          customOrder: undefined,
        });
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
    if (level.customOrder) {
      return level.ascending
        ? `custom:${level.customOrder}`
        : `customDesc:${level.customOrder}`;
    }
    return level.ascending ? "asc" : "desc";
  };

  // Build user list options for the order dropdown
  const userListOptions = useMemo(() => {
    return userLists.map((list) => ({
      id: list.items.join(","),
      label: list.name,
    }));
  }, [userLists]);

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
            {/* Built-in custom sort lists */}
            <optgroup label="Custom List">
              {BUILTIN_SORT_LISTS.map((list) => (
                <React.Fragment key={list.id}>
                  <option value={`custom:${list.id}`}>
                    {list.label}
                  </option>
                  <option value={`customDesc:${list.id}`}>
                    {list.label} (Desc)
                  </option>
                </React.Fragment>
              ))}
              {/* User-defined custom lists */}
              {userListOptions.map((list) => (
                <React.Fragment key={list.id}>
                  <option value={`custom:${list.id}`}>
                    {list.label}
                  </option>
                  <option value={`customDesc:${list.id}`}>
                    {list.label} (Desc)
                  </option>
                </React.Fragment>
              ))}
            </optgroup>
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
