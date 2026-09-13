//! FILENAME: app/extensions/Sorting/components/SortLevelRow.tsx
// PURPOSE: A single sort criterion row with Column, Sort On, and Order dropdowns.
// CONTEXT: Used within the Sort dialog to configure each sort level.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import type { SortLevel } from "../types";
import type { SortOn } from "@api/lib";
import { FillListRegistry, type FillList } from "@api";
import { useSortStore } from "../hooks/useSortState";
import {
  getUniqueColorsInColumn,
  getUniqueIconsInColumn,
  encodeIconOrderValue,
  decodeIconOrderValue,
  iconLabel,
  seedIconChoice,
  seedColorChoice,
  type IconChoice,
} from "../lib/sortHelpers";
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

  /**
   * The icons actually present in this level's column, in the set's own order.
   *
   * WHY THE BACKEND ANSWERS THIS and the colour scan does not. A cell's colour
   * is a property of its STYLE, which the frontend can read directly. A cell's
   * ICON is the outcome of evaluating the conditional-format rule cascade —
   * priority order, `enabled`, `stopIfTrue`, and thresholds that are usually
   * relative to RANGE STATISTICS. Re-deriving that here is exactly the mistake
   * BUG-0107 was (a frontend search that ignored `enabled` and priority handed
   * a DISABLED rule's glyph family to another rule's index), so this asks the
   * one evaluator instead and reads `iconSet` off the result rather than
   * guessing which rule produced it.
   *
   * `evaluateConditionalFormats` comes from `@api` — the Sorting extension must
   * not reach into ConditionalFormatting's own module.
   */
  const [uniqueIcons, setUniqueIcons] = useState<IconChoice[]>([]);

  useEffect(() => {
    // No synchronous clear here, deliberately. `uniqueIcons` is READ only
    // inside the `sortOn === "icon"` branches below, so a stale list can never
    // be shown for another sort mode — and clearing it in the effect body is a
    // setState-in-effect that the lint rule (rightly) objects to. The colour
    // scan beside this one predates that rule and still does it.
    if (level.sortOn !== "icon") return;
    const absoluteCol = rangeStartCol + level.columnKey;
    const dataStartRow = hasHeaders ? rangeStartRow + 1 : rangeStartRow;
    let cancelled = false;
    getUniqueIconsInColumn(dataStartRow, rangeEndRow, absoluteCol)
      .then((icons) => {
        if (!cancelled) setUniqueIcons(icons);
      })
      .catch(() => {
        if (!cancelled) setUniqueIcons([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    level.sortOn,
    level.columnKey,
    rangeStartRow,
    rangeEndRow,
    rangeStartCol,
    hasHeaders,
  ]);

  /**
   * SEED THE LEVEL WITH WHAT THE DROPDOWN IS ALREADY SHOWING.
   *
   * `getOrderValue` below falls back to `uniqueIcons[0]` / `uniqueColors[0]`
   * when the level names none, so the controlled `<select>` renders the first
   * entry as the selected one the instant the list arrives. A `<select>` fires
   * no change event for an option the user can already see chosen — so without
   * this, the person reads "Red arrow, On Top", clicks Sort, and the level
   * still carries `icon: undefined`.
   *
   * What that costs is different per branch and both are wrong:
   *   - icon:  `validate_sort_fields` refuses the whole sort with "names no
   *            icon. Choose which icon to bring to the top." — a correct
   *            message about a choice the dropdown is displaying. That is
   *            BUG-0104's own symptom, surviving inside BUG-0104's fix.
   *   - color: the backend's `(Some(a), Some(b), None)` arm falls back to
   *            comparing the colour strings, so the sort SUCCEEDS and orders
   *            by hex code instead of bringing the shown colour to the top.
   *            Worse than a refusal, because nothing says so.
   *
   * Seeding makes the displayed selection and the sent value the same object,
   * which demotes those `??` fallbacks from load-bearing to redundant. Kept as
   * its own effect, not folded into the fetches above: `level.icon` in the
   * fetch's dependency list would re-ask the backend for the same list every
   * time the person picks a different icon.
   *
   * It reseeds on ABSENT-FROM-THE-LIST, not merely on absent. Changing the
   * Column dropdown rewrites `columnKey` and leaves the icon alone, so the
   * level can hold an icon the NEW column never shows: `<select>` renders
   * blank for a value that matches no option, and the sort then keys on an
   * icon zero cells carry — it moves nothing and reports success, which is
   * this bug's defect class one more time.
   */
  useEffect(() => {
    if (level.sortOn === "icon") {
      const seed = seedIconChoice(level.icon, uniqueIcons);
      if (seed) updateLevel(level.id, { icon: seed });
      return;
    }
    if (level.sortOn === "cellColor" || level.sortOn === "fontColor") {
      const seed = seedColorChoice(level.color, uniqueColors);
      if (seed) updateLevel(level.id, { color: seed });
    }
  }, [
    level.sortOn,
    level.icon,
    level.color,
    level.id,
    uniqueIcons,
    uniqueColors,
    updateLevel,
  ]);

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
        // Reset color, icon and custom order when switching sort-on type. A
        // stale icon left on a value level is not merely untidy: the backend
        // refuses an icon level whose icon does not belong, and a stale colour
        // did the same for colour sorts.
        color: undefined,
        icon: undefined,
        customOrder: undefined,
      });
    },
    [level.id, updateLevel],
  );

  const handleOrderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;

      if (level.sortOn === "icon") {
        // One decoder, shared with the encoder that produced this value, so
        // the two cannot drift into producing NaN for an icon the user really
        // did choose.
        const { icon, onTop } = decodeIconOrderValue(value);
        updateLevel(level.id, {
          icon: icon ?? undefined,
          ascending: onTop,
          color: undefined,
          customOrder: undefined,
        });
      } else if (level.sortOn === "cellColor" || level.sortOn === "fontColor") {
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
    // DISPLAY IS DERIVED FROM THE SAME FUNCTION THE SEEDING EFFECT WRITES WITH,
    // so the shown option is always the value the level is about to carry. The
    // old `level.icon ?? uniqueIcons[0]` was an independent second opinion: it
    // made the dropdown look correct while the level stayed empty, which is the
    // exact shape of BUG-0104 — the dialog showing a choice it never sent.
    if (level.sortOn === "icon") {
      const chosen = seedIconChoice(level.icon, uniqueIcons) ?? level.icon;
      if (!chosen) return `||${level.ascending ? "top" : "bottom"}`;
      return encodeIconOrderValue(chosen, level.ascending);
    }
    if (level.sortOn === "cellColor" || level.sortOn === "fontColor") {
      const color =
        seedColorChoice(level.color, uniqueColors) ?? level.color ?? "";
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
        {level.sortOn === "icon" ? (
          // ONE ICON, brought to the top or the bottom — the same shape Excel
          // uses for sort-by-colour, and the shape the backend's
          // `SortField.icon` expects. "A to Z" was offered here before and was
          // meaningless: icons have no alphabet, and the level carried no icon,
          // so every such sort was refused by the backend with a message about
          // a choice this dropdown never offered.
          <>
            {uniqueIcons.length > 0 ? (
              uniqueIcons.flatMap((ic: IconChoice) => [
                <option key={encodeIconOrderValue(ic, true)} value={encodeIconOrderValue(ic, true)}>
                  {iconLabel(ic)} - On Top
                </option>,
                <option key={encodeIconOrderValue(ic, false)} value={encodeIconOrderValue(ic, false)}>
                  {iconLabel(ic)} - On Bottom
                </option>,
              ])
            ) : (
              <option value="||top">No icons found in this column</option>
            )}
          </>
        ) : level.sortOn === "value" ? (
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
