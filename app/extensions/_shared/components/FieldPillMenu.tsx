//! FILENAME: app/extensions/_shared/components/FieldPillMenu.tsx
// PURPOSE: Unified dropdown context menu for field pills in drop zones.
// CONTEXT: Replaces the separate 'v'/'x' buttons with a single dropdown menu
// that provides Value Field Settings, aggregation, move, and remove actions.

import React, { useEffect, useRef, useCallback } from 'react';
import { css } from '@emotion/css';
import type {
  DropZoneType,
  AggregationType,
} from './types';
import { AGGREGATION_OPTIONS } from './types';

export interface FieldPillMenuProps {
  position: { x: number; y: number };
  zone: DropZoneType;
  fieldIndex: number;
  totalFieldsInZone: number;
  aggregation?: AggregationType;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: (targetZone: DropZoneType) => void;
  onRemove: () => void;
  onValueFieldSettings?: () => void;
  onNumberFormat?: () => void;
  onAggregationChange?: (aggregation: AggregationType) => void;
  onClose: () => void;
}

const ZONE_LABELS: Record<DropZoneType, string> = {
  filters: 'Filters',
  columns: 'Columns',
  rows: 'Rows',
  values: 'Values',
};

const ALL_ZONES: DropZoneType[] = ['filters', 'columns', 'rows', 'values'];

const menuStyles = {
  container: css`
    position: fixed;
    background: #fff;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    z-index: 10000;
    min-width: 200px;
    max-height: 400px;
    overflow-y: auto;
    padding: 4px 0;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
  `,
  menuItem: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: #333;
    gap: 8px;
    font-size: 12px;
    font-family: inherit;

    &:hover {
      background: #f0f0f0;
    }

    &:focus {
      outline: none;
      background: #e8e8e8;
    }

    &:disabled {
      color: #aaa;
      cursor: default;

      &:hover {
        background: none;
      }
    }
  `,
  menuItemSelected: css`
    background: #e8f4fc;
    color: #005fb8;

    &:hover {
      background: #d6ecf8;
    }
  `,
  separator: css`
    height: 1px;
    background: #e0e0e0;
    margin: 4px 0;
  `,
  sectionLabel: css`
    padding: 4px 12px 2px;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  `,
  icon: css`
    width: 16px;
    text-align: center;
    color: #666;
    font-size: 13px;
    flex-shrink: 0;
  `,
  label: css`
    flex: 1;
  `,
  danger: css`
    color: #d32f2f;

    &:hover {
      background: #ffebee;
    }
  `,
};

export function FieldPillMenu({
  position,
  zone,
  fieldIndex,
  totalFieldsInZone,
  aggregation,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onRemove,
  onValueFieldSettings,
  onNumberFormat,
  onAggregationChange,
  onClose,
}: FieldPillMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleAction = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose]
  );

  // Adjust position to keep menu in viewport
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 220),
    y: Math.min(position.y, window.innerHeight - 300),
  };

  const isValues = zone === 'values';
  const canMoveUp = fieldIndex > 0;
  const canMoveDown = fieldIndex < totalFieldsInZone - 1;
  const otherZones = ALL_ZONES.filter((z) => z !== zone);

  return (
    <div
      ref={menuRef}
      className={menuStyles.container}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      {/* Value field specific actions */}
      {isValues && onValueFieldSettings && (
        <button
          className={menuStyles.menuItem}
          onClick={() => handleAction(onValueFieldSettings)}
        >
          <span className={menuStyles.icon}>&#9881;</span>
          <span className={menuStyles.label}>Value Field Settings...</span>
        </button>
      )}
      {isValues && onNumberFormat && (
        <button
          className={menuStyles.menuItem}
          onClick={() => handleAction(onNumberFormat)}
        >
          <span className={menuStyles.icon}>#</span>
          <span className={menuStyles.label}>Number Format...</span>
        </button>
      )}

      {/* Aggregation options for values zone */}
      {isValues && onAggregationChange && (
        <>
          <div className={menuStyles.separator} />
          <div className={menuStyles.sectionLabel}>Summarize by</div>
          {AGGREGATION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`${menuStyles.menuItem} ${
                aggregation === opt.value ? menuStyles.menuItemSelected : ''
              }`}
              onClick={() => handleAction(() => onAggregationChange(opt.value))}
            >
              <span className={menuStyles.icon}>
                {aggregation === opt.value ? '\u2713' : ''}
              </span>
              <span className={menuStyles.label}>{opt.label}</span>
            </button>
          ))}
        </>
      )}

      {/* Separator before move/remove actions */}
      {isValues && <div className={menuStyles.separator} />}

      {/* Move up/down */}
      <button
        className={menuStyles.menuItem}
        onClick={() => handleAction(onMoveUp)}
        disabled={!canMoveUp}
      >
        <span className={menuStyles.icon}>{'\u2191'}</span>
        <span className={menuStyles.label}>Move Up</span>
      </button>
      <button
        className={menuStyles.menuItem}
        onClick={() => handleAction(onMoveDown)}
        disabled={!canMoveDown}
      >
        <span className={menuStyles.icon}>{'\u2193'}</span>
        <span className={menuStyles.label}>Move Down</span>
      </button>

      <div className={menuStyles.separator} />

      {/* Move to other zones */}
      {otherZones.map((targetZone) => (
        <button
          key={targetZone}
          className={menuStyles.menuItem}
          onClick={() => handleAction(() => onMoveTo(targetZone))}
        >
          <span className={menuStyles.icon}>{'\u2192'}</span>
          <span className={menuStyles.label}>
            Move to {ZONE_LABELS[targetZone]}
          </span>
        </button>
      ))}

      <div className={menuStyles.separator} />

      {/* Remove */}
      <button
        className={`${menuStyles.menuItem} ${menuStyles.danger}`}
        onClick={() => handleAction(onRemove)}
      >
        <span className={menuStyles.icon}>&#10005;</span>
        <span className={menuStyles.label}>Remove Field</span>
      </button>
    </div>
  );
}
