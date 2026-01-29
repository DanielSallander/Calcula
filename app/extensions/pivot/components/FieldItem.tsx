//! FILENAME: app/src/core/components/pivot/FieldItem.tsx
import React, { useCallback, useMemo } from 'react';
import { styles } from './PivotEditor.styles';
import { useDraggable } from './useDragDrop';
import type { SourceField, DragField } from './types';

interface FieldItemProps {
  field: SourceField;
  isChecked: boolean;
  onToggle: (field: SourceField, checked: boolean) => void;
  // Legacy props kept for API compatibility - not used with mouse-based drag
  onDragStart?: (field: DragField) => void;
  onDragEnd?: () => void;
}

export function FieldItem({
  field,
  isChecked,
  onToggle,
}: FieldItemProps): React.ReactElement {
  const dragData: DragField = useMemo(
    () => ({
      sourceIndex: field.index,
      name: field.name,
      isNumeric: field.isNumeric,
    }),
    [field.index, field.name, field.isNumeric]
  );

  const { isDragging, dragHandleProps } = useDraggable(dragData, field.name);

  const handleCheckboxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onToggle(field, e.target.checked);
    },
    [field, onToggle]
  );

  return (
    <div
      {...dragHandleProps}
      className={`${styles.fieldItem} ${isDragging ? 'dragging' : ''}`}
    >
      <input
        type="checkbox"
        className={styles.fieldCheckbox}
        checked={isChecked}
        onChange={handleCheckboxChange}
      />
      <span className={styles.fieldName}>{field.name}</span>
      <span className={styles.fieldTypeIcon}>
        {field.isNumeric ? '#' : 'Aa'}
      </span>
    </div>
  );
}
