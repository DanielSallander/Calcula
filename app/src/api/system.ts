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
  updateWindowTitle,
  getCurrentFilePath,
  isDocumentEncrypted,
  encryptCurrentFile,
  removeFilePassword,
  registerPasswordPrompt,
} from '../core/lib/file-api';

export type {
  PasswordPromptRequest,
  PasswordPromptResult,
} from '../core/lib/file-api';
export { ENCRYPTION_STATE_CHANGED } from '../core/lib/file-api';

/**
 * Workbook API Facade.
 * Exposes file-system and document-lifecycle operations to extensions.
 *
 * Named for what it operates on. It was `workspace`, which collided with the
 * .calp vocabulary once a WORKSPACE became the shared folder that holds
 * published applications — and `workspace.save()` meaning "save the open
 * workbook" is confusing the moment both meanings are live. `document` was the
 * other candidate and is worse: it shadows the DOM global in any module that
 * imports it.
 */
export const workbook = {
  /** Creates a new, empty workbook. */
  new: newFile,

  /** Opens a file dialog to load a spreadsheet (handles encrypted files). */
  open: openFile,

  /** Saves the current workbook. Pass a password to encrypt. */
  save: saveFile,

  /** Opens a "Save As" dialog. Pass a password to encrypt. */
  saveAs: saveFileAs,

  /** Whether the open workbook has unsaved changes. */
  isModified: isFileModified,

  /** Marks the open workbook as modified. */
  markModified: markFileModified,

  /** Gets the current file path, or null if unsaved. */
  getCurrentPath: getCurrentFilePath,

  /** Updates the window title to reflect filename and dirty state. */
  updateTitle: updateWindowTitle,

  /** Whether the currently-open document is encrypted. */
  isEncrypted: isDocumentEncrypted,

  /** Encrypt (or change the password of) the current workbook and save it. */
  encrypt: encryptCurrentFile,

  /** Remove encryption from the current workbook and re-save it as plain. */
  removePassword: removeFilePassword,

  /** Register the UI implementation used to prompt for a passphrase on open. */
  registerPasswordPrompt,
};
