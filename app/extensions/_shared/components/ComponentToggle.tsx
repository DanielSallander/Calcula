//! FILENAME: app/extensions/_shared/components/ComponentToggle.tsx
// PURPOSE: Toggle button for switching between PivotTable and Tablix component types.
// CONTEXT: Placed at the top of the editor panel in both Pivot and Tablix extensions.

import React, { useCallback, useState } from 'react';
import { css } from '@emotion/css';

export type ComponentType = 'pivot' | 'tablix';

interface ComponentToggleProps {
  currentType: ComponentType;
  onConvert: (targetType: ComponentType) => Promise<void>;
}

const toggleStyles = {
  container: css`
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: #f0f4f8;
    border-bottom: 1px solid #e5e5e5;
    gap: 6px;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  `,
  label: css`
    font-size: 11px;
    color: #666;
    margin-right: 4px;
  `,
  buttonGroup: css`
    display: flex;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    overflow: hidden;
    flex: 1;
  `,
  button: css`
    flex: 1;
    padding: 5px 10px;
    border: none;
    background: #fff;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    color: #555;
    transition: all 0.1s ease;
    white-space: nowrap;

    &:first-child {
      border-right: 1px solid #d0d0d0;
    }

    &:hover:not(.active):not(:disabled) {
      background: #f0f0f0;
    }

    &.active {
      background: #005fb8;
      color: #fff;
      cursor: default;
    }

    &:disabled {
      opacity: 0.6;
      cursor: wait;
    }
  `,
};

export function ComponentToggle({
  currentType,
  onConvert,
}: ComponentToggleProps): React.ReactElement {
  const [isConverting, setIsConverting] = useState(false);

  const handleToggle = useCallback(async (targetType: ComponentType) => {
    if (targetType === currentType || isConverting) return;

    setIsConverting(true);
    try {
      await onConvert(targetType);
    } catch (error) {
      console.error('Component conversion failed:', error);
    } finally {
      setIsConverting(false);
    }
  }, [currentType, isConverting, onConvert]);

  return (
    <div className={toggleStyles.container}>
      <span className={toggleStyles.label}>Type:</span>
      <div className={toggleStyles.buttonGroup}>
        <button
          className={`${toggleStyles.button}${currentType === 'pivot' ? ' active' : ''}`}
          onClick={() => handleToggle('pivot')}
          disabled={isConverting}
        >
          PivotTable
        </button>
        <button
          className={`${toggleStyles.button}${currentType === 'tablix' ? ' active' : ''}`}
          onClick={() => handleToggle('tablix')}
          disabled={isConverting}
        >
          Tablix
        </button>
      </div>
    </div>
  );
}
