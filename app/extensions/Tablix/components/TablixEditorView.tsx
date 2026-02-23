//! FILENAME: app/extensions/Tablix/components/TablixEditorView.tsx
// PURPOSE: Task Pane view wrapper for TablixEditor.
// CONTEXT: Adapts TablixEditor to work within the Task Pane system.

import React from 'react';
import { TablixEditor } from './TablixEditor';
import type { TaskPaneViewProps } from '../../../src/api';
import type { TablixEditorViewData } from '../types';

/**
 * Task Pane view component for the Tablix Editor.
 */
export function TablixEditorView({
  onClose,
  onUpdate,
  data,
}: TaskPaneViewProps): React.ReactElement | null {
  const tablixData = data as TablixEditorViewData | undefined;

  if (!tablixData || !tablixData.tablixId) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: '#999',
          fontSize: '13px',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        Select a cell within a Tablix to edit its fields.
      </div>
    );
  }

  return (
    <TablixEditor
      tablixId={tablixData.tablixId}
      sourceFields={tablixData.sourceFields}
      initialRowGroups={tablixData.initialRowGroups}
      initialColumnGroups={tablixData.initialColumnGroups}
      initialDataFields={tablixData.initialDataFields}
      initialFilters={tablixData.initialFilters}
      initialLayout={tablixData.initialLayout}
      onClose={onClose}
      onViewUpdate={onUpdate}
    />
  );
}
