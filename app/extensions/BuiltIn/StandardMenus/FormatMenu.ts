//! FILENAME: app/extensions/BuiltIn/StandardMenus/FormatMenu.ts
// PURPOSE: Format menu registration using the Command Pattern.
// CONTEXT: Registers the Format menu with items for cell formatting.

import React from 'react';
import { CoreCommands } from '../../../src/api/commands';
import { registerMenu } from '../../../src/api/ui';
import type { MenuDefinition } from '../../../src/api/ui';
import { applyFormatting } from '../../../src/api/lib';
import { cellEvents, useGridState } from '../../../src/api';
import { CellStylesGallery } from '../HomeTab/components/CellStylesGallery';
import type { CellStyleDefinition } from '../HomeTab/components/CellStylesGallery';

/**
 * Wrapper component for the Cell Styles gallery inside the Format menu.
 * Reads the current selection and applies formatting via the standard pipeline.
 */
function CellStylesMenuPanel({ onClose }: { onClose: () => void }) {
  const gridState = useGridState();

  const handleApply = React.useCallback(
    async (formatting: CellStyleDefinition["formatting"]) => {
      const sel = gridState.selection;
      if (!sel) return;
      const startRow = Math.min(sel.startRow, sel.endRow);
      const endRow = Math.max(sel.startRow, sel.endRow);
      const startCol = Math.min(sel.startCol, sel.endCol);
      const endCol = Math.max(sel.startCol, sel.endCol);
      const rows: number[] = [];
      const cols: number[] = [];
      for (let r = startRow; r <= endRow; r++) rows.push(r);
      for (let c = startCol; c <= endCol; c++) cols.push(c);
      try {
        const result = await applyFormatting(
          rows,
          cols,
          formatting as Parameters<typeof applyFormatting>[2],
        );
        for (const cell of result.cells) {
          cellEvents.emit({
            row: cell.row,
            col: cell.col,
            oldValue: undefined,
            newValue: cell.display,
            formula: cell.formula,
          });
        }
        window.dispatchEvent(new CustomEvent("styles:refresh"));
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } catch (err) {
        console.error("[FormatMenu] Failed to apply cell style:", err);
      }
    },
    [gridState.selection],
  );

  return React.createElement(CellStylesGallery, {
    onApplyStyle: handleApply,
    onClose,
    inline: true,
  });
}

/**
 * Register the Format menu with the Menu Registry.
 * Placed between Edit (order=20) and View (order=40).
 */
export function registerFormatMenu(): void {
  const menu: MenuDefinition = {
    id: 'format',
    label: 'Format',
    order: 35,
    items: [
      {
        id: 'format:cells',
        label: 'Format Cells...',
        shortcut: 'Ctrl+1',
        commandId: CoreCommands.FORMAT_CELLS,
      },
      { id: 'format:sep1', label: '', separator: true },
      {
        id: 'format:cellStyles',
        label: 'Cell Styles',
        customContent: (onClose: () => void) =>
          React.createElement(CellStylesMenuPanel, { onClose }),
      },
    ],
  };

  registerMenu(menu);
}
