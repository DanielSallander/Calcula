//! FILENAME: app/extensions/Tablix/manifest.ts
// PURPOSE: Tablix extension manifest and registration definitions.
// CONTEXT: Defines what the tablix extension contributes to the application.

import type {
  AddInManifest,
  TaskPaneViewDefinition,
  DialogDefinition,
  OverlayDefinition,
} from '../../src/api';
import { emitAppEvent } from '../../src/api';
import type { DialogProps, OverlayProps } from '../../src/api';
import React from 'react';
import { TablixEvents } from './lib/tablixEvents';
import { CreateTablixDialog } from './components/CreateTablixDialog';
import { TablixEditorView } from './components/TablixEditorView';
import { FilterDropdown } from '../_shared/components/FilterDropdown';

// ============================================================================
// Extension Manifest
// ============================================================================

export const TABLIX_EXTENSION_ID = 'calcula.tablix';

export const TablixManifest: AddInManifest = {
  id: TABLIX_EXTENSION_ID,
  name: 'Tablix Reports',
  version: '1.0.0',
  description: 'Tablix (Table/Matrix/List) report functionality for Calcula',
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Task Pane Registration
// ============================================================================

export const TABLIX_PANE_ID = 'tablix-editor';

export const TablixPaneDefinition: TaskPaneViewDefinition = {
  id: TABLIX_PANE_ID,
  title: 'Tablix Fields',
  icon: '[T]',
  component: TablixEditorView,
  contextKeys: ['tablix'],
  priority: 100,
  closable: true,
};

// ============================================================================
// Dialog Registration
// ============================================================================

export const TABLIX_DIALOG_ID = 'tablix:createDialog';

// Wrapper component to adapt CreateTablixDialog to DialogProps interface
function CreateTablixDialogWrapper(props: DialogProps): React.ReactElement {
  return React.createElement(CreateTablixDialog, {
    isOpen: props.isOpen,
    onClose: props.onClose,
    onCreated: (tablixId: number) => {
      emitAppEvent(TablixEvents.TABLIX_CREATED, { tablixId });
      props.onClose();
    },
    selection: props.data?.selection as
      | { startRow: number; startCol: number; endRow: number; endCol: number }
      | undefined,
  });
}

export const TablixDialogDefinition: DialogDefinition = {
  id: TABLIX_DIALOG_ID,
  component: CreateTablixDialogWrapper,
  priority: 100,
};

// ============================================================================
// Overlay Registration
// ============================================================================

export const TABLIX_FILTER_OVERLAY_ID = 'tablix:filterDropdown';

// Wrapper component to adapt FilterDropdown to OverlayProps interface
function FilterDropdownWrapper(props: OverlayProps): React.ReactElement {
  const data = props.data ?? {};
  return React.createElement(FilterDropdown, {
    fieldName: (data.fieldName as string) ?? '',
    fieldIndex: (data.fieldIndex as number) ?? 0,
    uniqueValues: (data.uniqueValues as string[]) ?? [],
    selectedValues: (data.selectedValues as string[]) ?? [],
    anchorRect: props.anchorRect ?? { x: 0, y: 0, width: 150, height: 24 },
    onApply: (data.onApply as (
      fieldIndex: number,
      selectedValues: string[],
      hiddenItems: string[]
    ) => Promise<void>) ?? (async () => {}),
    onClose: props.onClose,
  });
}

export const TablixFilterOverlayDefinition: OverlayDefinition = {
  id: TABLIX_FILTER_OVERLAY_ID,
  component: FilterDropdownWrapper,
  layer: 'dropdown',
};
