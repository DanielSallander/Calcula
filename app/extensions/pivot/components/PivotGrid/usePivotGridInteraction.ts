// FILENAME: app/extensions/Pivot/components/PivotGrid/usePivotGridInteraction.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import { pivot } from '../../../../src/api/pivot';
import type {
  PivotViewResponse,
  FilterRowData,
  PivotId,
  PivotInteractiveBounds,
} from '../../../../src/api/pivot';

// =============================================================================
// TYPES
// =============================================================================

export interface ActiveFilterDropdown {
  fieldIndex: number;
  filterRow: FilterRowData;
  anchorRect: { x: number; y: number; width: number; height: number };
}

export interface CellPosition {
  row: number;
  col: number;
}

export interface SelectionRange {
  start: CellPosition;
  end: CellPosition;
}

export interface UsePivotGridInteractionOptions {
  pivotId: PivotId;
  pivotView: PivotViewResponse | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  interactiveBounds: PivotInteractiveBounds | null;
  onExpandCollapse?: (row: number, col: number, isExpanded: boolean) => void;
  onSelectionChange?: (selection: SelectionRange | null) => void;
  onRefresh?: () => void;
}

export interface UsePivotGridInteractionResult {
  // Selection state
  selectedCell: CellPosition | null;
  selectionRange: SelectionRange | null;

  // Filter dropdown state
  activeFilterDropdown: ActiveFilterDropdown | null;
  handleCloseFilterDropdown: () => void;
  handleApplyFilter: (fieldIndex: number, selectedValues: string[], hiddenItems: string[]) => Promise<void>;

  // Hover state
  hoveredFilterFieldIndex: number | null;
  hoveredIconKey: string | null;

  // Event handlers
  handleCanvasClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasMouseLeave: () => void;
  handleCanvasDoubleClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;

  // Actions
  requestRedraw: () => void;
}

// =============================================================================
// HOOK
// =============================================================================

export function usePivotGridInteraction(
  options: UsePivotGridInteractionOptions
): UsePivotGridInteractionResult {
  const {
    pivotId,
    pivotView,
    canvasRef,
    interactiveBounds,
    onExpandCollapse,
    onSelectionChange,
    onRefresh,
  } = options;

  // Selection state
  const [selectedCell, setSelectedCell] = useState<CellPosition | null>(null);
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);

  // Filter dropdown state
  const [activeFilterDropdown, setActiveFilterDropdown] = useState<ActiveFilterDropdown | null>(null);

  // Hover state
  const [hoveredFilterFieldIndex, setHoveredFilterFieldIndex] = useState<number | null>(null);
  const [hoveredIconKey, setHoveredIconKey] = useState<string | null>(null);

  // Redraw trigger
  const redrawRequestedRef = useRef(false);
  const [, forceUpdate] = useState({});

  const requestRedraw = useCallback(() => {
    if (!redrawRequestedRef.current) {
      redrawRequestedRef.current = true;
      requestAnimationFrame(() => {
        redrawRequestedRef.current = false;
        forceUpdate({});
      });
    }
  }, []);

  // ==========================================================================
  // HIT TESTING HELPERS
  // ==========================================================================

  const findClickedFilterButton = useCallback(
    (canvasX: number, canvasY: number): {
      fieldIndex: number;
      row: number;
      col: number;
      bounds: { x: number; y: number; width: number; height: number };
    } | null => {
      if (!interactiveBounds?.filterButtons) return null;

      for (const [, bounds] of interactiveBounds.filterButtons) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          return {
            fieldIndex: bounds.fieldIndex,
            row: bounds.row,
            col: bounds.col,
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
          };
        }
      }
      return null;
    },
    [interactiveBounds]
  );

  const findClickedExpandIcon = useCallback(
    (canvasX: number, canvasY: number): {
      row: number;
      col: number;
      isExpanded: boolean;
      key: string;
    } | null => {
      if (!interactiveBounds?.expandCollapseIcons) return null;

      for (const [key, bounds] of interactiveBounds.expandCollapseIcons) {
        if (
          canvasX >= bounds.x &&
          canvasX <= bounds.x + bounds.width &&
          canvasY >= bounds.y &&
          canvasY <= bounds.y + bounds.height
        ) {
          return {
            row: bounds.row,
            col: bounds.col,
            isExpanded: bounds.isExpanded,
            key,
          };
        }
      }
      return null;
    },
    [interactiveBounds]
  );

  // ==========================================================================
  // FILTER DROPDOWN HANDLERS
  // ==========================================================================

  const handleCloseFilterDropdown = useCallback(() => {
    setActiveFilterDropdown(null);
  }, []);

  const handleApplyFilter = useCallback(
    async (fieldIndex: number, _selectedValues: string[], hiddenItems: string[]) => {
      if (!pivotView) return;

      try {
        // Build the filter field config for the specific field
        const filterFieldConfig = {
          source_index: fieldIndex,
          name: pivotView.filter_rows.find(fr => fr.field_index === fieldIndex)?.field_name || '',
          hidden_items: hiddenItems.length > 0 ? hiddenItems : undefined,
        };

        // Call API to update pivot fields
        await pivot.updateFields({
          pivot_id: pivotId,
          filter_fields: [filterFieldConfig],
        });

        // Close dropdown
        setActiveFilterDropdown(null);

        // Trigger refresh
        onRefresh?.();
      } catch (error) {
        console.error('Failed to apply filter:', error);
      }
    },
    [pivotId, pivotView, onRefresh]
  );

  // ==========================================================================
  // CANVAS EVENT HANDLERS
  // ==========================================================================

  const handleCanvasClick = useCallback(
    async (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !pivotView) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // 1. Check filter button clicks FIRST
      const clickedFilter = findClickedFilterButton(canvasX, canvasY);
      if (clickedFilter) {
        // Find the filter row metadata from pivotView
        const filterRowMeta = pivotView.filter_rows?.find(
          (fr) => fr.field_index === clickedFilter.fieldIndex
        );

        // Fetch unique values from backend API (always fresh)
        try {
          const response = await pivot.getFieldUniqueValues(
            pivotId,
            clickedFilter.fieldIndex
          );

          // Build filterRow with fetched unique values
          const filterRow: FilterRowData = {
            field_index: clickedFilter.fieldIndex,
            field_name: response.field_name,
            unique_values: response.unique_values,
            // Use existing selected values from metadata, or default to all selected
            selected_values: filterRowMeta?.selected_values ?? response.unique_values,
            display_value: filterRowMeta?.display_value ?? '(All)',
            view_row: filterRowMeta?.view_row ?? 0,
          };

          // Convert canvas coords to screen coords for dropdown positioning
          const screenX = rect.left + clickedFilter.bounds.x;
          const screenY = rect.top + clickedFilter.bounds.y + clickedFilter.bounds.height + 2;

          setActiveFilterDropdown({
            fieldIndex: clickedFilter.fieldIndex,
            filterRow,
            anchorRect: {
              x: screenX,
              y: screenY,
              width: clickedFilter.bounds.width,
              height: clickedFilter.bounds.height,
            },
          });
        } catch (error) {
          console.error('Failed to fetch filter unique values:', error);
        }
        return;
      }

      // 2. Check expand/collapse icon clicks
      const clickedIcon = findClickedExpandIcon(canvasX, canvasY);
      if (clickedIcon) {
        onExpandCollapse?.(clickedIcon.row, clickedIcon.col, clickedIcon.isExpanded);
        return;
      }

      // 3. Handle cell selection
      // TODO: Implement cell hit testing based on row/column positions
      // For now, just clear selection when clicking elsewhere
      if (selectedCell) {
        setSelectedCell(null);
        setSelectionRange(null);
        onSelectionChange?.(null);
      }
    },
    [
      canvasRef,
      pivotId,
      pivotView,
      findClickedFilterButton,
      findClickedExpandIcon,
      onExpandCollapse,
      selectedCell,
      onSelectionChange,
    ]
  );

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      let cursorStyle = 'default';
      let needsRedraw = false;

      // Check filter button hover
      const hoveredFilter = findClickedFilterButton(canvasX, canvasY);
      const newHoveredFilterIndex = hoveredFilter?.fieldIndex ?? null;

      if (newHoveredFilterIndex !== hoveredFilterFieldIndex) {
        setHoveredFilterFieldIndex(newHoveredFilterIndex);
        needsRedraw = true;
      }

      if (hoveredFilter) {
        cursorStyle = 'pointer';
      }

      // Check expand/collapse icon hover
      const hoveredIcon = findClickedExpandIcon(canvasX, canvasY);
      const newHoveredIconKey = hoveredIcon?.key ?? null;

      if (newHoveredIconKey !== hoveredIconKey) {
        setHoveredIconKey(newHoveredIconKey);
        needsRedraw = true;
      }

      if (hoveredIcon) {
        cursorStyle = 'pointer';
      }

      // Update cursor
      canvas.style.cursor = cursorStyle;

      // Request redraw if hover state changed
      if (needsRedraw) {
        requestRedraw();
      }
    },
    [
      canvasRef,
      findClickedFilterButton,
      findClickedExpandIcon,
      hoveredFilterFieldIndex,
      hoveredIconKey,
      requestRedraw,
    ]
  );

  const handleCanvasMouseLeave = useCallback(() => {
    let needsRedraw = false;

    if (hoveredFilterFieldIndex !== null) {
      setHoveredFilterFieldIndex(null);
      needsRedraw = true;
    }

    if (hoveredIconKey !== null) {
      setHoveredIconKey(null);
      needsRedraw = true;
    }

    if (needsRedraw) {
      requestRedraw();
    }
  }, [hoveredFilterFieldIndex, hoveredIconKey, requestRedraw]);

  const handleCanvasDoubleClick = useCallback(
    (_e: React.MouseEvent<HTMLCanvasElement>) => {
      // TODO: Implement double-click behavior (e.g., expand all, drill-through)
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Close filter dropdown on Escape
      if (e.key === 'Escape' && activeFilterDropdown) {
        e.preventDefault();
        setActiveFilterDropdown(null);
        return;
      }

      // TODO: Implement keyboard navigation
      // Arrow keys for selection movement
      // Enter for expand/collapse
      // Space for selection toggle
    },
    [activeFilterDropdown]
  );

  // ==========================================================================
  // EFFECT: Selection change notification
  // ==========================================================================

  useEffect(() => {
    if (selectionRange) {
      onSelectionChange?.(selectionRange);
    }
  }, [selectionRange, onSelectionChange]);

  // ==========================================================================
  // RETURN
  // ==========================================================================

  return {
    // Selection state
    selectedCell,
    selectionRange,

    // Filter dropdown state
    activeFilterDropdown,
    handleCloseFilterDropdown,
    handleApplyFilter,

    // Hover state
    hoveredFilterFieldIndex,
    hoveredIconKey,

    // Event handlers
    handleCanvasClick,
    handleCanvasMouseMove,
    handleCanvasMouseLeave,
    handleCanvasDoubleClick,
    handleKeyDown,

    // Actions
    requestRedraw,
  };
}

export default usePivotGridInteraction;