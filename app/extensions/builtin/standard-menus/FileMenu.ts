//! FILENAME: app/extensions/builtin/standard-menus/FileMenu.ts
import { useCallback } from 'react';
import { newFile, openFile, saveFile, saveFileAs, isFileModified } from '../../../src/core/lib/file-api';
import type { MenuDefinition } from '../../../src/api/ui';

export interface FileMenuHandlers {
  handleNew: () => Promise<void>;
  handleOpen: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
}

export function useFileMenu(): { menu: MenuDefinition; handlers: FileMenuHandlers } {
  const handleNew = useCallback(async () => {
    try {
      const modified = await isFileModified();
      if (modified) {
        const confirmed = window.confirm('You have unsaved changes. Create new file anyway?');
        if (!confirmed) return;
      }
      await newFile();
      window.location.reload();
    } catch (error) {
      console.error('[FileMenu] handleNew error:', error);
      alert('Failed to create new file: ' + String(error));
    }
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      const modified = await isFileModified();
      if (modified) {
        const confirmed = window.confirm('You have unsaved changes. Open file anyway?');
        if (!confirmed) return;
      }
      const cells = await openFile();
      if (cells) {
        window.location.reload();
      }
    } catch (error) {
      console.error('[FileMenu] handleOpen error:', error);
      alert('Failed to open file: ' + String(error));
    }
  }, []);

  const handleSave = useCallback(async () => {
    try {
      const path = await saveFile();
      if (path) {
        console.log('[FileMenu] Saved to:', path);
      }
    } catch (error) {
      console.error('[FileMenu] handleSave error:', error);
      alert('Failed to save file: ' + String(error));
    }
  }, []);

  const handleSaveAs = useCallback(async () => {
    try {
      const path = await saveFileAs();
      if (path) {
        console.log('[FileMenu] Saved as:', path);
      }
    } catch (error) {
      console.error('[FileMenu] handleSaveAs error:', error);
      alert('Failed to save file: ' + String(error));
    }
  }, []);

  const menu: MenuDefinition = {
    id: 'file',
    label: 'File',
    order: 10,
    items: [
      { id: 'file.new', label: 'New', shortcut: 'Ctrl+N', action: handleNew },
      { id: 'file.open', label: 'Open...', shortcut: 'Ctrl+O', action: handleOpen },
      { id: 'file.sep1', label: '', separator: true },
      { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', action: handleSave },
      { id: 'file.saveas', label: 'Save As...', shortcut: 'Ctrl+Shift+S', action: handleSaveAs },
    ],
  };

  return {
    menu,
    handlers: { handleNew, handleOpen, handleSave, handleSaveAs },
  };
}
