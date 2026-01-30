//! FILENAME: app/src/api/system.ts
// PURPOSE: System API Facade for extensions.
// CONTEXT: Exposes file system and workspace operations to extensions.
// Extensions import from this module instead of core/lib/file-api directly.

import {
  newFile,
  openFile,
  saveFile,
  saveFileAs,
  isFileModified,
  markFileModified,
  getCurrentFilePath,
} from '../core/lib/file-api';

/**
 * Workspace API Facade.
 * Exposes file system and workspace operations to extensions.
 */
export const workspace = {
  /** Creates a new spreadsheet workspace. */
  new: newFile,

  /** Opens a file dialog to load a spreadsheet. */
  open: openFile,

  /** Saves the current workbook. */
  save: saveFile,

  /** Opens a "Save As" dialog. */
  saveAs: saveFileAs,

  /** Checks if the current workspace has unsaved changes. */
  isModified: isFileModified,

  /** Marks the current workspace as modified. */
  markModified: markFileModified,

  /** Gets the current file path, or null if unsaved. */
  getCurrentPath: getCurrentFilePath,
};
