//! FILENAME: app\src\core\components\pivot\FilterDropdown.tsx
import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface FilterDropdownProps {
  fieldName: string;
  fieldIndex: number;
  uniqueValues: string[];
  selectedValues: string[];
  anchorRect: { x: number; y: number; width: number; height: number } | undefined;
  onApply: (fieldIndex: number, selectedValues: string[], hiddenItems: string[]) => Promise<void>;
  onClose: () => void;
}

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  fieldName,
  fieldIndex,
  uniqueValues,
  selectedValues,
  anchorRect,
  onApply,
  onClose,
}) => {
  // CRITICAL FIX: Guard clause to prevent crash if anchorRect is undefined
  // Must be BEFORE any hooks to follow Rules of Hooks
  if (!anchorRect) {
    return null;
  }

  // Defensive: ensure arrays are valid
  const safeUniqueValues = Array.isArray(uniqueValues) ? uniqueValues : [];
  const safeSelectedValues = Array.isArray(selectedValues) ? selectedValues : [];

  const [localSelectedValues, setLocalSelectedValues] = useState<Set<string>>(
    new Set(safeSelectedValues)
  );
  const [searchText, setSearchText] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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

  const filteredValues = safeUniqueValues.filter((v) =>
    v.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleToggleValue = useCallback((value: string) => {
    setLocalSelectedValues((prev) => {
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
    setLocalSelectedValues(new Set(safeUniqueValues));
  }, [safeUniqueValues]);

  const handleSelectNone = useCallback(() => {
    setLocalSelectedValues(new Set());
  }, []);

  const handleApply = useCallback(async () => {
    const selected = Array.from(localSelectedValues);
    const hidden = safeUniqueValues.filter((v) => !localSelectedValues.has(v));
    await onApply(fieldIndex, selected, hidden);
  }, [fieldIndex, localSelectedValues, safeUniqueValues, onApply]);

  return (
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        left: anchorRect.x,
        top: anchorRect.y,
        width: 250,
        maxHeight: 350,
        backgroundColor: '#ffffff',
        border: '1px solid #d1d5db',
        borderRadius: 4,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: '#374151', // Ensure default text color is dark
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
          fontWeight: 600,
          color: '#374151',
        }}
      >
        Filter: {fieldName}
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <input
          type="text"
          placeholder="Search..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box', // Fixes width overflow
            backgroundColor: '#ffffff', // Ensures white background
            color: '#374151', // Ensures text is visible
          }}
        />
      </div>

      {/* Select All / None */}
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          onClick={handleSelectAll}
          style={{
            padding: '4px 8px',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            background: '#f9fafb',
            cursor: 'pointer',
            fontSize: 12,
            color: '#374151', // Fix: Make text visible
          }}
        >
          Select All
        </button>
        <button
          onClick={handleSelectNone}
          style={{
            padding: '4px 8px',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            background: '#f9fafb',
            cursor: 'pointer',
            fontSize: 12,
            color: '#374151', // Fix: Make text visible
          }}
        >
          Select None
        </button>
      </div>

      {/* Values list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0',
          maxHeight: 200,
        }}
      >
        {filteredValues.map((value) => (
          <label
            key={value}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '4px 12px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={localSelectedValues.has(value)}
              onChange={() => handleToggleValue(value)}
              style={{ marginRight: 8 }}
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {value || '(Blank)'}
            </span>
          </label>
        ))}
        {filteredValues.length === 0 && (
          <div style={{ padding: '8px 12px', color: '#6b7280', fontStyle: 'italic' }}>
            No matching values
          </div>
        )}
      </div>

      {/* Footer buttons */}
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid #e5e7eb',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
        }}
      >
        <button
          onClick={onClose}
          style={{
            padding: '6px 12px',
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
            padding: '6px 12px',
            border: 'none',
            borderRadius: 4,
            background: '#3b82f6',
            color: '#ffffff',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
};

export default FilterDropdown;