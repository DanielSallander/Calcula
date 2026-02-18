//! FILENAME: app/extensions/AutoFilter/components/FilterDropdownOverlay.tsx
// PURPOSE: React overlay component for the filter dropdown menu.
// CONTEXT: Shows a checkbox list of unique values, search, and Select All.

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { OverlayProps } from "../../../src/api";
import type { FilterDropdownData } from "../types";
import {
  applyColumnFilter,
  clearColumnFilter,
  getColumnUniqueValues,
  setOpenDropdownCol,
  getAutoFilterInfo,
} from "../lib/filterStore";
import { emitAppEvent, restoreFocusToGrid } from "../../../src/api";
import { FilterEvents } from "../lib/filterEvents";
import {
  DropdownContainer,
  SearchContainer,
  SearchInput,
  CheckboxList,
  CheckboxItem,
  CheckboxInput,
  ValueLabel,
  ButtonRow,
  ActionButton,
  ClearFilterLink,
  SelectAllItem,
  EmptyMessage,
} from "./FilterDropdownOverlay.styles";

interface FilterDropdownState {
  /** All unique values in the column */
  allValues: string[];
  /** Whether column has blank cells */
  hasBlanks: boolean;
  /** Set of currently checked values */
  checkedValues: Set<string>;
  /** Whether blanks are checked */
  blanksChecked: boolean;
  /** Search text */
  searchText: string;
  /** Whether data is loading */
  loading: boolean;
}

const FilterDropdownOverlay: React.FC<OverlayProps> = ({ onClose, data, anchorRect }) => {
  const dropdownData = data as unknown as FilterDropdownData | undefined;
  if (!dropdownData) return null;

  const { relativeCol, columnName } = dropdownData;

  const [state, setState] = useState<FilterDropdownState>({
    allValues: [],
    hasBlanks: false,
    checkedValues: new Set(),
    blanksChecked: true,
    searchText: "",
    loading: true,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load unique values on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const result = await getColumnUniqueValues(relativeCol);
      if (cancelled) return;

      const values = result.values.map((v) => v.value);
      const info = getAutoFilterInfo();
      const criteria = info?.criteria[relativeCol];

      // Determine which values are checked
      let checked: Set<string>;
      let blanksChecked: boolean;

      if (criteria && criteria.values && criteria.values.length > 0) {
        // Filter is active - check only the selected values
        const filterValues = new Set(criteria.values);
        checked = new Set(values.filter((v) => filterValues.has(v)));
        blanksChecked = filterValues.has("(Blanks)");
      } else if (criteria) {
        // Filter exists but no value list (custom/dynamic filter) - check all
        checked = new Set(values);
        blanksChecked = true;
      } else {
        // No filter - all values are checked
        checked = new Set(values);
        blanksChecked = true;
      }

      setState({
        allValues: values,
        hasBlanks: result.hasBlanks,
        checkedValues: checked,
        blanksChecked,
        searchText: "",
        loading: false,
      });
    }

    load();
    return () => { cancelled = true; };
  }, [relativeCol]);

  // Focus search on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      searchRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    }
    // Use setTimeout to avoid catching the click that opened the dropdown
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleClose = useCallback(() => {
    setOpenDropdownCol(null);
    emitAppEvent(FilterEvents.FILTER_DROPDOWN_CLOSE);
    onClose();
    restoreFocusToGrid();
  }, [onClose]);

  // Filtered values based on search text
  const filteredValues = useMemo(() => {
    if (!state.searchText) return state.allValues;
    const lower = state.searchText.toLowerCase();
    return state.allValues.filter((v) => v.toLowerCase().includes(lower));
  }, [state.allValues, state.searchText]);

  // Select All state: "all", "none", or "partial"
  const selectAllState = useMemo(() => {
    const totalCheckable = filteredValues.length + (state.hasBlanks && !state.searchText ? 1 : 0);
    let checkedCount = filteredValues.filter((v) => state.checkedValues.has(v)).length;
    if (state.hasBlanks && !state.searchText && state.blanksChecked) checkedCount++;
    if (checkedCount === 0) return "none";
    if (checkedCount === totalCheckable) return "all";
    return "partial";
  }, [filteredValues, state.checkedValues, state.hasBlanks, state.blanksChecked, state.searchText]);

  const handleSelectAll = () => {
    setState((prev) => {
      if (selectAllState === "all") {
        // Uncheck all visible
        const newChecked = new Set(prev.checkedValues);
        for (const v of filteredValues) newChecked.delete(v);
        return { ...prev, checkedValues: newChecked, blanksChecked: prev.searchText ? prev.blanksChecked : false };
      } else {
        // Check all visible
        const newChecked = new Set(prev.checkedValues);
        for (const v of filteredValues) newChecked.add(v);
        return { ...prev, checkedValues: newChecked, blanksChecked: prev.searchText ? prev.blanksChecked : true };
      }
    });
  };

  const handleToggleValue = (value: string) => {
    setState((prev) => {
      const newChecked = new Set(prev.checkedValues);
      if (newChecked.has(value)) {
        newChecked.delete(value);
      } else {
        newChecked.add(value);
      }
      return { ...prev, checkedValues: newChecked };
    });
  };

  const handleToggleBlanks = () => {
    setState((prev) => ({ ...prev, blanksChecked: !prev.blanksChecked }));
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => ({ ...prev, searchText: e.target.value }));
  };

  const handleOk = async () => {
    const selectedValues = Array.from(state.checkedValues);
    const allSelected =
      selectedValues.length === state.allValues.length &&
      state.blanksChecked === (state.hasBlanks ? true : state.blanksChecked);

    if (allSelected && (!state.hasBlanks || state.blanksChecked)) {
      // All values selected - clear the filter for this column
      await clearColumnFilter(relativeCol);
    } else {
      // Apply the filter with selected values
      await applyColumnFilter(relativeCol, selectedValues, state.blanksChecked);
    }

    handleClose();
  };

  const handleClearFilter = async () => {
    await clearColumnFilter(relativeCol);
    handleClose();
  };

  // Position the dropdown
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.left = anchorRect.x;
    style.top = anchorRect.y;
  }

  const info = getAutoFilterInfo();
  const hasActiveFilter = info?.criteria[relativeCol] != null;

  if (state.loading) {
    return (
      <DropdownContainer ref={containerRef} style={style}>
        <EmptyMessage>Loading...</EmptyMessage>
      </DropdownContainer>
    );
  }

  return (
    <DropdownContainer ref={containerRef} style={style}>
      {hasActiveFilter && (
        <ClearFilterLink onClick={handleClearFilter}>
          Clear Filter from "{columnName}"
        </ClearFilterLink>
      )}

      <SearchContainer>
        <SearchInput
          ref={searchRef}
          type="text"
          placeholder="Search..."
          value={state.searchText}
          onChange={handleSearchChange}
        />
      </SearchContainer>

      <SelectAllItem>
        <CheckboxInput
          type="checkbox"
          checked={selectAllState === "all"}
          ref={(el) => {
            if (el) el.indeterminate = selectAllState === "partial";
          }}
          onChange={handleSelectAll}
        />
        <ValueLabel>(Select All)</ValueLabel>
      </SelectAllItem>

      <CheckboxList>
        {filteredValues.map((value) => (
          <CheckboxItem key={value}>
            <CheckboxInput
              type="checkbox"
              checked={state.checkedValues.has(value)}
              onChange={() => handleToggleValue(value)}
            />
            <ValueLabel title={value}>{value}</ValueLabel>
          </CheckboxItem>
        ))}

        {state.hasBlanks && !state.searchText && (
          <CheckboxItem $dimmed>
            <CheckboxInput
              type="checkbox"
              checked={state.blanksChecked}
              onChange={handleToggleBlanks}
            />
            <ValueLabel>(Blanks)</ValueLabel>
          </CheckboxItem>
        )}

        {filteredValues.length === 0 && !state.hasBlanks && (
          <EmptyMessage>No matching values</EmptyMessage>
        )}
      </CheckboxList>

      <ButtonRow>
        <ActionButton onClick={handleClose}>Cancel</ActionButton>
        <ActionButton $primary onClick={handleOk}>OK</ActionButton>
      </ButtonRow>
    </DropdownContainer>
  );
};

export default FilterDropdownOverlay;
