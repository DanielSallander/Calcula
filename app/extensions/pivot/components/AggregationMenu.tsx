//! FILENAME: app/extensions/pivot/components/AggregationMenu.tsx
import React, { useEffect, useRef, useCallback } from 'react';
import { styles } from './PivotEditor.styles';
import { AGGREGATION_OPTIONS, type AggregationType } from './types';

interface AggregationMenuProps {
  currentAggregation: AggregationType;
  position: { x: number; y: number };
  onSelect: (aggregation: AggregationType) => void;
  onClose: () => void;
}

export function AggregationMenu({
  currentAggregation,
  position,
  onSelect,
  onClose,
}: AggregationMenuProps): React.ReactElement {
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

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleSelect = useCallback(
    (aggregation: AggregationType) => {
      onSelect(aggregation);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <div
      ref={menuRef}
      className={styles.aggregationMenu}
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {AGGREGATION_OPTIONS.map((option) => (
        <button
          key={option.value}
          className={`${styles.aggregationMenuItem} ${
            option.value === currentAggregation ? 'selected' : ''
          }`}
          onClick={() => handleSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}