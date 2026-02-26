//! FILENAME: app/extensions/Pivot/components/PivotHeaderFilterDropdown.tsx
//! PURPOSE: Combined filter/sort dropdown for Row Labels and Column Labels headers.
//! Matches Excel's header filter dropdown with field selector, sort options,
//! search, checkbox list, and OK/Cancel buttons.

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { pivot } from '../../../src/api/pivot';
import type { HeaderFieldSummary, PivotId } from '../../../src/api/pivot';

// =============================================================================
// TYPES
// =============================================================================

export interface PivotHeaderFilterDropdownProps {
  /** Which zone this dropdown controls */
  zone: 'row' | 'column';
  /** Available fields in this zone */
  fields: HeaderFieldSummary[];
  /** Pivot table ID */
  pivotId: PivotId;
  /** Position to anchor the dropdown */
  anchorRect: { x: number; y: number; width: number; height: number };
  /** Close callback */
  onClose: () => void;
  /** Callback after applying filter or sort (to refresh view) */
  onApply: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const PivotHeaderFilterDropdown: React.FC<PivotHeaderFilterDropdownProps> = ({
  zone,
  fields,
  pivotId,
  anchorRect,
  onClose,
  onApply,
}) => {
  // State
  const [selectedFieldIndex, setSelectedFieldIndex] = useState<number>(
    fields[0]?.fieldIndex ?? -1
  );
  const [searchText, setSearchText] = useState('');
  const [uniqueValues, setUniqueValues] = useState<string[]>([]);
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set());
  const [isLoadingValues, setIsLoadingValues] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay to avoid closing from the triggering click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Auto-focus search input
  useEffect(() => {
    const timer = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Fetch unique values and current filter state when field selection changes
  useEffect(() => {
    if (selectedFieldIndex < 0) return;
    let cancelled = false;

    const fetchFieldData = async () => {
      setIsLoadingValues(true);
      try {
        // Fetch unique values
        const valuesResponse = await pivot.getFieldUniqueValues(pivotId, selectedFieldIndex);
        if (cancelled) return;

        const allValues = valuesResponse.uniqueValues;
        setUniqueValues(allValues);

        // Fetch field info for current filter state
        try {
          const fieldInfo = await pivot.getFieldInfo(pivotId, selectedFieldIndex);
          if (cancelled) return;

          // If field has manual filter with selected items, use those
          if (fieldInfo.filters?.manualFilter?.selectedItems?.length) {
            setSelectedValues(new Set(fieldInfo.filters.manualFilter.selectedItems));
          } else if (fieldInfo.isFiltered) {
            // Use visible items
            const visibleItems = fieldInfo.items
              .filter(item => item.visible)
              .map(item => item.name);
            setSelectedValues(new Set(visibleItems));
          } else {
            // All selected by default
            setSelectedValues(new Set(allValues));
          }
        } catch {
          // If field info fetch fails, default to all selected
          if (!cancelled) {
            setSelectedValues(new Set(allValues));
          }
        }
      } catch (err) {
        console.error('Failed to fetch field data:', err);
        if (!cancelled) {
          setUniqueValues([]);
          setSelectedValues(new Set());
        }
      } finally {
        if (!cancelled) {
          setIsLoadingValues(false);
        }
      }
    };

    fetchFieldData();
    setSearchText('');
    return () => { cancelled = true; };
  }, [pivotId, selectedFieldIndex]);

  // Filter values by search text
  const filteredValues = useMemo(() => {
    if (!searchText) return uniqueValues;
    const lower = searchText.toLowerCase();
    return uniqueValues.filter(v => v.toLowerCase().includes(lower));
  }, [uniqueValues, searchText]);

  // Select all state
  const selectAllState = useMemo((): 'all' | 'none' | 'partial' => {
    if (selectedValues.size === 0) return 'none';
    if (selectedValues.size === uniqueValues.length) return 'all';
    return 'partial';
  }, [selectedValues, uniqueValues]);

  // Handlers
  const handleFieldChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedFieldIndex(Number(e.target.value));
  }, []);

  const handleToggleValue = useCallback((value: string) => {
    setSelectedValues(prev => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedValues(new Set(uniqueValues));
  }, [uniqueValues]);

  const handleSelectNone = useCallback(() => {
    setSelectedValues(new Set());
  }, []);

  const handleSortAZ = useCallback(async () => {
    try {
      await pivot.sortField({
        pivotId,
        fieldIndex: selectedFieldIndex,
        sortBy: 'ascending',
      });
      onApply();
      onClose();
    } catch (err) {
      console.error('Failed to sort:', err);
    }
  }, [pivotId, selectedFieldIndex, onApply, onClose]);

  const handleSortZA = useCallback(async () => {
    try {
      await pivot.sortField({
        pivotId,
        fieldIndex: selectedFieldIndex,
        sortBy: 'descending',
      });
      onApply();
      onClose();
    } catch (err) {
      console.error('Failed to sort:', err);
    }
  }, [pivotId, selectedFieldIndex, onApply, onClose]);

  const handleApply = useCallback(async () => {
    try {
      if (selectedValues.size === uniqueValues.length) {
        // All selected - clear filter
        await pivot.clearFilter({
          pivotId,
          fieldIndex: selectedFieldIndex,
        });
      } else {
        // Apply manual filter with selected items
        await pivot.applyFilter({
          pivotId,
          fieldIndex: selectedFieldIndex,
          filters: {
            manualFilter: {
              selectedItems: Array.from(selectedValues),
            },
          },
        });
      }
      onApply();
      onClose();
    } catch (err) {
      console.error('Failed to apply filter:', err);
    }
  }, [pivotId, selectedFieldIndex, selectedValues, uniqueValues.length, onApply, onClose]);

  // Position the dropdown
  const dropdownStyle: React.CSSProperties = {
    position: 'fixed',
    left: anchorRect.x,
    top: anchorRect.y,
    width: 260,
    maxHeight: 420,
    backgroundColor: '#ffffff',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    fontSize: 13,
    color: '#374151',
  };

  const selectedField = fields.find(f => f.fieldIndex === selectedFieldIndex);

  return (
    <div ref={dropdownRef} style={dropdownStyle}>
      {/* Select Field dropdown (only show if multiple fields) */}
      {fields.length > 1 && (
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
        }}>
          <div style={{ marginBottom: 4, fontSize: 12, color: '#6b7280' }}>
            Select field:
          </div>
          <select
            value={selectedFieldIndex}
            onChange={handleFieldChange}
            style={{
              width: '100%',
              padding: '4px 6px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              fontSize: 13,
              backgroundColor: '#ffffff',
              color: '#374151',
              cursor: 'pointer',
            }}
          >
            {fields.map(f => (
              <option key={f.fieldIndex} value={f.fieldIndex}>
                {f.fieldName}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Header with field name (when single field) */}
      {fields.length <= 1 && (
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
          fontWeight: 600,
        }}>
          {selectedField?.fieldName || (zone === 'row' ? 'Row Labels' : 'Column Labels')}
        </div>
      )}

      {/* Sort options */}
      <div style={{ borderBottom: '1px solid #e5e7eb' }}>
        <button
          onClick={handleSortAZ}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '6px 12px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 13,
            color: '#374151',
            textAlign: 'left',
          }}
          onMouseOver={e => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
          onMouseOut={e => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          Sort A to Z
        </button>
        <button
          onClick={handleSortZA}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '6px 12px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 13,
            color: '#374151',
            textAlign: 'left',
          }}
          onMouseOver={e => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
          onMouseOut={e => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          Sort Z to A
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search..."
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
            backgroundColor: '#ffffff',
            color: '#374151',
          }}
        />
      </div>

      {/* Select All checkbox */}
      <div style={{
        padding: '4px 12px',
        borderBottom: '1px solid #e5e7eb',
      }}>
        <label style={{
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          padding: '2px 0',
        }}>
          <input
            type="checkbox"
            checked={selectAllState === 'all'}
            ref={el => {
              if (el) el.indeterminate = selectAllState === 'partial';
            }}
            onChange={() => {
              if (selectAllState === 'all') {
                handleSelectNone();
              } else {
                handleSelectAll();
              }
            }}
            style={{ marginRight: 8 }}
          />
          <span style={{ fontWeight: 500 }}>(Select All)</span>
        </label>
      </div>

      {/* Values list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '4px 0',
        maxHeight: 180,
      }}>
        {isLoadingValues ? (
          <div style={{ padding: '8px 12px', color: '#6b7280', fontStyle: 'italic' }}>
            Loading...
          </div>
        ) : filteredValues.length === 0 ? (
          <div style={{ padding: '8px 12px', color: '#6b7280', fontStyle: 'italic' }}>
            No matching values
          </div>
        ) : (
          filteredValues.map(value => (
            <label
              key={value}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '3px 12px',
                cursor: 'pointer',
              }}
              onMouseOver={e => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
              onMouseOut={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <input
                type="checkbox"
                checked={selectedValues.has(value)}
                onChange={() => handleToggleValue(value)}
                style={{ marginRight: 8 }}
              />
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {value || '(Blank)'}
              </span>
            </label>
          ))
        )}
      </div>

      {/* Footer buttons */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid #e5e7eb',
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
      }}>
        <button
          onClick={onClose}
          style={{
            padding: '6px 16px',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            background: '#ffffff',
            cursor: 'pointer',
            fontSize: 13,
            color: '#374151',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleApply}
          style={{
            padding: '6px 16px',
            border: 'none',
            borderRadius: 4,
            background: '#3b82f6',
            color: '#ffffff',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
};

export default PivotHeaderFilterDropdown;
