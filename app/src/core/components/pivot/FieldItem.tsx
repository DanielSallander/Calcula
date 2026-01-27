//! FILENAME: app/src/core/components/pivot/FieldItem.tsx
import React, { useCallback } from 'react';
import { styles } from './PivotEditor.styles';
import type { SourceField, DragField, DropZoneType } from './types';

interface FieldItemProps {
  field: SourceField;
  isChecked: boolean;
  onToggle: (field: SourceField, checked: boolean) => void;
  onDragStart: (field: DragField) => void;
  onDragEnd: () => void;
}

export function FieldItem({
  field,
  isChecked,
  onToggle,
  onDragStart,
  onDragEnd,
}: FieldItemProps): React.ReactElement {
  const [isDragging, setIsDragging] = React.useState(false);

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const dragData: DragField = {
        sourceIndex: field.index,
        name: field.name,
        isNumeric: field.isNumeric,
      };
      e.dataTransfer.setData('application/json', JSON.stringify(dragData));
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
      onDragStart(dragData);
    },
    [field, onDragStart]
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    onDragEnd();
  }, [onDragEnd]);

  const handleCheckboxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onToggle(field, e.target.checked);
    },
    [field, onToggle]
  );

  return (
    <div
      className={`${styles.fieldItem} ${isDragging ? 'dragging' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
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