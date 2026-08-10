//! FILENAME: app/extensions/BuiltIn/StandardMenus/FileMenu.ts
// ARCHITECTURE: Uses the System API facade (The Facade Rule).
// Extensions must ONLY import from app/src/api.
import type { MenuDefinition } from '@api/ui';
import { workspace } from '@api/system';
import { IconNew, IconOpen, IconSave, IconSaveAs } from '@api';
import { confirmAsync, alertAsync } from "@api/dialogs";

export interface FileMenuHandlers {
  handleNew: () => Promise<void>;
  handleOpen: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
}

// Plain module functions (not hooks): they use only the stable `workspace`
// facade + window, so they need no React lifecycle. The SAME functions back both
// the menu-item `action` (click) and the registry command registered in
// index.ts (Ctrl+N/O/S/Shift+S keyboard dispatch) — one source of truth.

export async function fileNew(): Promise<void> {
  try {
    const modified = await workspace.isModified();
    if (modified) {
      // AWAITED. `!confirmed` on a Promise was always false, so Cancel discarded
      // the unsaved workbook and reloaded the window regardless.
      const confirmed = await confirmAsync(
        'You have unsaved changes. Create new file anyway?',
        { title: 'Unsaved changes', kind: 'warning' },
      );
      if (!confirmed) return;
    }
    await workspace.new();
    window.location.reload();
  } catch (error) {
    console.error('[FileMenu] handleNew error:', error);
    void alertAsync('Failed to create new file: ' + String(error));
  }
}

export async function fileOpen(): Promise<void> {
  try {
    // UNSAVED-CHANGES GUARD, same as `fileNew` above. Opening replaces the
    // whole document and resets the undo stack, so without this a single
    // Ctrl+O discarded unsaved work with no prompt and nothing to undo -- the
    // one document-replacing gesture in the app that did not ask. It runs
    // BEFORE the picker: asking afterwards makes the user choose a file and
    // only then tells them the choice costs them their edits.
    const modified = await workspace.isModified();
    if (modified) {
      const confirmed = await confirmAsync(
        'You have unsaved changes. Open another file anyway?',
        { title: 'Unsaved changes', kind: 'warning' },
      );
      if (!confirmed) return;
    }
    const cells = await workspace.open();
    if (cells) {
      window.location.reload();
    }
  } catch (error) {
    console.error('[FileMenu] handleOpen error:', error);
    void alertAsync('Failed to open file: ' + String(error));
  }
}

export async function fileSave(): Promise<void> {
  try {
    const path = await workspace.save();
    if (path) {
      console.log('[FileMenu] Saved to:', path);
    }
  } catch (error) {
    console.error('[FileMenu] handleSave error:', error);
    void alertAsync('Failed to save file: ' + String(error));
  }
}

export async function fileSaveAs(): Promise<void> {
  try {
    const path = await workspace.saveAs();
    if (path) {
      console.log('[FileMenu] Saved as:', path);
    }
  } catch (error) {
    console.error('[FileMenu] handleSaveAs error:', error);
    void alertAsync('Failed to save file: ' + String(error));
  }
}

export function useFileMenu(): { menu: MenuDefinition; handlers: FileMenuHandlers } {
  const menu: MenuDefinition = {
    id: 'file',
    label: 'File',
    order: 10,
    items: [
      { id: 'file.new', label: 'New', icon: IconNew, shortcut: 'Ctrl+N', action: fileNew },
      { id: 'file.open', label: 'Open...', icon: IconOpen, shortcut: 'Ctrl+O', action: fileOpen },
      { id: 'file.sep1', label: '', separator: true },
      { id: 'file.save', label: 'Save', icon: IconSave, shortcut: 'Ctrl+S', action: fileSave },
      { id: 'file.saveas', label: 'Save As...', icon: IconSaveAs, shortcut: 'Ctrl+Shift+S', action: fileSaveAs },
    ],
  };

  return {
    menu,
    handlers: { handleNew: fileNew, handleOpen: fileOpen, handleSave: fileSave, handleSaveAs: fileSaveAs },
  };
}
