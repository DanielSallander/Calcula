//! FILENAME: app/src/shell/MenuBar/menus/EditMenu.ts
import { useCallback } from 'react';
import { undo, redo, mergeCells, unmergeCells } from '../../../core/lib/tauri-api';
import type { Menu } from '../MenuBar.types';
import { MenuEvents, emitMenuEvent, restoreFocusToGrid } from '../MenuBar.events';

export interface EditMenuHandlers {
  handleUndo: () => Promise<void>;
  handleRedo: () => Promise<void>;
  handleCut: () => void;
  handleCopy: () => void;
  handlePaste: () => void;
  handleFind: () => void;
  handleReplace: () => void;
  handleMergeCells: () => Promise<void>;
  handleUnmergeCells: () => Promise<void>;
}

export interface EditMenuDependencies {
  selection: {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  } | null;
}

export function useEditMenu(deps: EditMenuDependencies): { menu: Menu; handlers: EditMenuHandlers; canMerge: boolean } {
  const { selection } = deps;

  const canMerge = selection !== null && (
    selection.startRow !== selection.endRow ||
    selection.startCol !== selection.endCol
  );

  const handleUndo = useCallback(async () => {
    try {
      const result = await undo();
      console.log('[EditMenu] Undo result:', result);
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[EditMenu] handleUndo error:', error);
    }
  }, []);

  const handleRedo = useCallback(async () => {
    try {
      const result = await redo();
      console.log('[EditMenu] Redo result:', result);
      window.dispatchEvent(new CustomEvent('grid:refresh'));
    } catch (error) {
      console.error('[EditMenu] handleRedo error:', error);
    }
  }, []);

  const handleCut = useCallback(() => {
    emitMenuEvent(MenuEvents.CUT);
    restoreFocusToGrid();
  }, []);

  const handleCopy = useCallback(() => {
    emitMenuEvent(MenuEvents.COPY);
    restoreFocusToGrid();
  }, []);

  const handlePaste = useCallback(() => {
    emitMenuEvent(MenuEvents.PASTE);
    restoreFocusToGrid();
  }, []);

  const handleFind = useCallback(() => {
    emitMenuEvent(MenuEvents.FIND);
  }, []);

  const handleReplace = useCallback(() => {
    emitMenuEvent(MenuEvents.REPLACE);
  }, []);

  const handleMergeCells = useCallback(async () => {
    if (!selection) return;

    console.log('[EditMenu] handleMergeCells called with selection:', selection);
    try {
      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRow = Math.max(selection.startRow, selection.endRow);
      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      const result = await mergeCells(minRow, minCol, maxRow, maxCol);
      console.log('[EditMenu] mergeCells result:', result);

      if (result.success) {
        emitMenuEvent(MenuEvents.CELLS_MERGED, result);
        window.dispatchEvent(new CustomEvent('grid:refresh'));
      } else {
        console.warn('[EditMenu] Merge failed - possibly overlapping regions');
      }
    } catch (error) {
      console.error('[EditMenu] handleMergeCells error:', error);
      alert('Failed to merge cells: ' + String(error));
    }
  }, [selection]);

  const handleUnmergeCells = useCallback(async () => {
    if (!selection) return;

    console.log('[EditMenu] handleUnmergeCells called with selection:', selection);
    try {
      const result = await unmergeCells(selection.startRow, selection.startCol);
      console.log('[EditMenu] unmergeCells result:', result);

      if (result.success) {
        emitMenuEvent(MenuEvents.CELLS_UNMERGED, result);
        window.dispatchEvent(new CustomEvent('grid:refresh'));
      }
    } catch (error) {
      console.error('[EditMenu] handleUnmergeCells error:', error);
      alert('Failed to unmerge cells: ' + String(error));
    }
  }, [selection]);

  const menu: Menu = {
    label: 'Edit',
    items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', action: handleUndo },
      { label: 'Redo', shortcut: 'Ctrl+Y', action: handleRedo },
      { separator: true, label: '' },
      { label: 'Cut', shortcut: 'Ctrl+X', action: handleCut },
      { label: 'Copy', shortcut: 'Ctrl+C', action: handleCopy },
      { label: 'Paste', shortcut: 'Ctrl+V', action: handlePaste },
      { separator: true, label: '' },
      { label: 'Find...', shortcut: 'Ctrl+F', action: handleFind },
      { label: 'Replace...', shortcut: 'Ctrl+H', action: handleReplace },
      { separator: true, label: '' },
      { label: 'Merge Cells', shortcut: 'Ctrl+M', action: handleMergeCells, disabled: !canMerge },
      { label: 'Unmerge Cells', action: handleUnmergeCells },
    ],
  };

  return {
    menu,
    handlers: {
      handleUndo,
      handleRedo,
      handleCut,
      handleCopy,
      handlePaste,
      handleFind,
      handleReplace,
      handleMergeCells,
      handleUnmergeCells,
    },
    canMerge,
  };
}