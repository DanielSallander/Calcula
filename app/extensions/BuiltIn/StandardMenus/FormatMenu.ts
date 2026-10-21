//! FILENAME: app/extensions/BuiltIn/StandardMenus/FormatMenu.ts
// PURPOSE: Format menu registration using the Command Pattern.
// CONTEXT: Registers the Format menu with items for cell formatting.

import React from 'react';
import { CoreCommands } from '@api/commands';
import { registerMenu, unregisterMenu } from '@api/ui';
import type { MenuDefinition } from '@api/ui';
import { applyFormatting } from '@api/lib';
import { useGridState, IconFormatCells, IconCellStyles } from '@api';
import { resolveCellTarget, targetRefOf } from '@api/cellTarget';
import { announceFormattingResult } from '@api/announceFormatting';
import { CellStylesGallery } from '../../_shared/components/CellStylesGallery';
import type { CellStyleDefinition } from '../../_shared/components/CellStylesGallery';

/**
 * Wrapper component for the Cell Styles gallery inside the Format menu.
 * Reads the current selection and applies formatting via the standard pipeline.
 */
function CellStylesMenuPanel({ onClose }: { onClose: () => void }) {
  const gridState = useGridState();

  const handleApply = React.useCallback(
    async (formatting: CellStyleDefinition["formatting"]) => {
      // WHICH cells (P3): Core's selection, or a floating grid's own cells
      // (written through their target) when its owner admits "format". An
      // owner that does not admit it refuses, once -- the style never lands
      // on the sheet cell hidden under the grid (BUG-0185).
      const t = resolveCellTarget("Cell Style", "format");
      if (t === null) return;
      const target = targetRefOf(t);
      const sel = t.kind === "object" ? t.selection : gridState.selection;
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
          { target },
        );
        // The ONE announcement: cell events (none for a target), then the
        // style and grid refreshes.
        announceFormattingResult(result, { target });
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
 * Returns the teardown (deactivate): the menu is this extension's, so it goes
 * with it; items other extensions added to it are kept by the registry.
 */
export function registerFormatMenu(): () => void {
  const menu: MenuDefinition = {
    id: 'format',
    label: 'Format',
    order: 35,
    items: [
      {
        id: 'format:cells',
        label: 'Format Cells...',
        icon: IconFormatCells,
        shortcut: 'Ctrl+1',
        commandId: CoreCommands.FORMAT_CELLS,
      },
      { id: 'format:sep1', label: '', separator: true },
      {
        id: 'format:cellStyles',
        label: 'Cell Styles',
        icon: IconCellStyles,
        customContent: (onClose: () => void) =>
          React.createElement(CellStylesMenuPanel, { onClose }),
      },
    ],
  };

  registerMenu(menu);
  return () => unregisterMenu(menu.id);
}
