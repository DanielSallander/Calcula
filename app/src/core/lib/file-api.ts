//! FILENAME: app/src/core/lib/file-api.ts
import { tracedInvoke } from '../../utils/bridge';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { CellData } from '../types/types';
import { emitAppEvent, AppEvents } from './events';

const CALCULA_FILTER = {
  name: 'Calcula Workbook',
  extensions: ['cala'],
};

const XLSX_FILTER = {
  name: 'Excel Workbook',
  extensions: ['xlsx'],
};

const ALL_FILTER = {
  name: 'All Files',
  extensions: ['*'],
};

// ============================================================================
// Encryption: password-prompt hook (Inversion of Control)
// ----------------------------------------------------------------------------
// Core must not import the Shell/Extensions, but opening an encrypted workbook
// needs a UI password prompt. So Core exposes a hook here; the Encryption
// extension registers a prompt implementation that drives the actual dialog.
// ============================================================================

/** Reason the prompt is being shown, so the dialog can tailor its message. */
export interface PasswordPromptRequest {
  /** The file being opened (for display / keychain context). */
  path: string;
  /** 'wrong' when a previous attempt failed authentication; null on first ask. */
  errorKind: 'wrong' | null;
  /** Zero-based count of prior failed attempts in this open. */
  attempt: number;
}

export interface PasswordPromptResult {
  password: string;
  /** Whether to remember the passphrase in the OS keychain for this machine. */
  remember: boolean;
}

type PasswordPromptFn = (
  req: PasswordPromptRequest
) => Promise<PasswordPromptResult | null>;

let passwordPromptFn: PasswordPromptFn | null = null;

/** Registered by the Encryption extension. Pass `null` to unregister. */
export function registerPasswordPrompt(fn: PasswordPromptFn | null): void {
  passwordPromptFn = fn;
}

/** Emitted after the document's encryption state may have changed (open / save /
 *  encrypt / remove-password / new), so UI (e.g. menus) can refresh. */
export const ENCRYPTION_STATE_CHANGED = 'app:encryption-state-changed';

// --- keychain (Windows Credential Manager) wrappers ------------------------
// These call backend commands only; safe to use from Core. All failures are
// swallowed (the keychain is a convenience, never a correctness dependency).

async function keychainGet(path: string): Promise<string | null> {
  try {
    return await tracedInvoke<string | null>('keychain_get_password', { path });
  } catch (e) {
    console.warn('[FILE] keychain get failed:', e);
    return null;
  }
}

async function keychainSet(path: string, password: string): Promise<void> {
  try {
    await tracedInvoke('keychain_set_password', { path, password });
  } catch (e) {
    console.warn('[FILE] keychain set failed:', e);
  }
}

async function keychainDelete(path: string): Promise<void> {
  try {
    await tracedInvoke('keychain_delete_password', { path });
  } catch (e) {
    console.warn('[FILE] keychain delete failed:', e);
  }
}

/** Classify an open_file error by its sentinel string. */
function encErrorKind(error: unknown): 'needs' | 'wrong' | 'corrupt' | null {
  const m = error instanceof Error ? error.message : String(error);
  if (m.includes('ENC_NEEDS_PASSWORD')) return 'needs';
  if (m.includes('ENC_WRONG_PASSWORD')) return 'wrong';
  if (m.includes('ENC_CORRUPT')) return 'corrupt';
  return null;
}

// ============================================================================
// Save
// ============================================================================

/**
 * Save As. `password` is optional; when omitted the backend falls back to the
 * session passphrase so an encrypted document stays encrypted.
 */
export async function saveFileAs(password?: string): Promise<string | null> {
  try {
    const path = await save({
      filters: [CALCULA_FILTER, XLSX_FILTER, ALL_FILTER],
      defaultPath: 'Workbook.cala',
    });

    if (path) {
      emitAppEvent(AppEvents.BEFORE_SAVE, { path });
      await tracedInvoke('save_file', { path, password });
      emitAppEvent(AppEvents.AFTER_SAVE, { path });
      emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: false });
      emitAppEvent(ENCRYPTION_STATE_CHANGED);
      updateWindowTitle();
      return path;
    }
    return null;
  } catch (error) {
    console.error('[FILE] saveFileAs error:', error);
    throw error;
  }
}

/**
 * Save to the current path (or prompt for one). `password` is optional; when
 * omitted the backend keeps the document's existing encryption state.
 */
export async function saveFile(password?: string): Promise<string | null> {
  try {
    const currentPath = await getCurrentFilePath();

    if (currentPath) {
      emitAppEvent(AppEvents.BEFORE_SAVE, { path: currentPath });
      await tracedInvoke('save_file', { path: currentPath, password });
      emitAppEvent(AppEvents.AFTER_SAVE, { path: currentPath });
      emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: false });
      emitAppEvent(ENCRYPTION_STATE_CHANGED);
      updateWindowTitle();
      return currentPath;
    }

    return saveFileAs(password);
  } catch (error) {
    console.error('[FILE] saveFile error:', error);
    throw error;
  }
}

// ============================================================================
// Open
// ============================================================================

/**
 * Open a workbook. Shows the file picker, then loads it — transparently
 * handling encrypted `.cala` files: a remembered passphrase (keychain) is tried
 * first, otherwise the registered password prompt is shown and retried until the
 * user succeeds or cancels. Returns `null` if the user cancels either dialog.
 */
export async function openFile(): Promise<CellData[] | null> {
  try {
    const path = await open({
      filters: [CALCULA_FILTER, XLSX_FILTER, ALL_FILTER],
      multiple: false,
      directory: false,
    });

    if (!(path && typeof path === 'string')) return null;
    return await openFileAtPath(path);
  } catch (error) {
    console.error('[FILE] openFile error:', error);
    throw error;
  }
}

/**
 * Load a workbook from a known path (no file picker). Drives the same
 * encryption unlock flow as {@link openFile}.
 */
export async function openFileAtPath(path: string): Promise<CellData[] | null> {
  emitAppEvent(AppEvents.BEFORE_OPEN, { path });

  // Try a remembered passphrase first (only encrypted files ever have one).
  let password: string | undefined = (await keychainGet(path)) ?? undefined;
  let fromKeychain = password !== undefined;
  let pendingRemember = false;
  let attempt = 0;

  for (;;) {
    try {
      const cells = await tracedInvoke<CellData[]>('open_file', { path, password });

      // Success. Persist the passphrase if the user asked us to remember it.
      if (pendingRemember && password) {
        await keychainSet(path, password);
      }
      emitAppEvent(AppEvents.AFTER_OPEN, { path });
      emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: false });
      emitAppEvent(ENCRYPTION_STATE_CHANGED);
      updateWindowTitle();
      return cells;
    } catch (error) {
      const kind = encErrorKind(error);

      // Not an encryption problem, or unrecoverable corruption: surface it.
      if (kind === null || kind === 'corrupt') {
        console.error('[FILE] openFileAtPath error:', error);
        throw error;
      }

      // A stale remembered passphrase was wrong: forget it and prompt fresh.
      if (kind === 'wrong' && fromKeychain) {
        await keychainDelete(path);
        fromKeychain = false;
      }

      // No UI prompt is available (e.g. headless/tests): propagate the sentinel.
      if (!passwordPromptFn) {
        throw error;
      }

      const result = await passwordPromptFn({
        path,
        errorKind: kind === 'wrong' ? 'wrong' : null,
        attempt,
      });
      if (!result) {
        // User cancelled the unlock — treat as "no file opened".
        return null;
      }

      password = result.password;
      pendingRemember = result.remember;
      fromKeychain = false;
      attempt += 1;
    }
  }
}

// ============================================================================
// New
// ============================================================================

export async function newFile(): Promise<void> {
  try {
    emitAppEvent(AppEvents.BEFORE_NEW);
    await tracedInvoke('new_file', {});
    emitAppEvent(AppEvents.AFTER_NEW);
    emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: false });
    emitAppEvent(ENCRYPTION_STATE_CHANGED);
    updateWindowTitle();
  } catch (error) {
    console.error('[FILE] newFile error:', error);
    throw error;
  }
}

// ============================================================================
// Encryption actions (driven by the Encryption extension UI)
// ============================================================================

/** Whether the currently-open document is encrypted. */
export async function isDocumentEncrypted(): Promise<boolean> {
  try {
    return await tracedInvoke<boolean>('is_document_encrypted', {});
  } catch {
    return false;
  }
}

/**
 * Encrypt (or change the password of) the current workbook and save it.
 * Remembers the passphrase in the keychain when `remember` is set, otherwise
 * forgets any previously-remembered one. Returns the saved path, or null if the
 * user cancelled an underlying Save-As picker.
 */
export async function encryptCurrentFile(
  password: string,
  remember: boolean
): Promise<string | null> {
  const savedPath = await saveFile(password);
  if (savedPath) {
    if (remember) await keychainSet(savedPath, password);
    else await keychainDelete(savedPath);
    emitAppEvent(ENCRYPTION_STATE_CHANGED);
  }
  return savedPath;
}

/**
 * Remove encryption from the current workbook: clear the session passphrase,
 * re-save as a plain ZIP, and forget any remembered passphrase.
 */
export async function removeFilePassword(): Promise<string | null> {
  const currentPath = await getCurrentFilePath();
  await tracedInvoke('clear_session_password', {});
  const savedPath = await saveFile();
  if (savedPath) await keychainDelete(savedPath);
  else if (currentPath) await keychainDelete(currentPath);
  emitAppEvent(ENCRYPTION_STATE_CHANGED);
  return savedPath;
}

// ============================================================================
// Misc
// ============================================================================

export async function getCurrentFilePath(): Promise<string | null> {
  return tracedInvoke<string | null>('get_current_file_path', {});
}

export async function isFileModified(): Promise<boolean> {
  return tracedInvoke<boolean>('is_file_modified', {});
}

export async function markFileModified(): Promise<void> {
  await tracedInvoke('mark_file_modified', {});
  emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: true });
}

/**
 * Update the window title to reflect the current file name and dirty state.
 * Format: "filename - Calcula" or "filename * - Calcula" when dirty.
 */
export async function updateWindowTitle(): Promise<void> {
  const [filePath, isDirty] = await Promise.all([
    getCurrentFilePath(),
    isFileModified(),
  ]);

  const fileName = filePath
    ? filePath.replace(/\\/g, '/').split('/').pop() || 'Untitled'
    : 'Untitled';

  const dirtyIndicator = isDirty ? ' *' : '';
  document.title = `${fileName}${dirtyIndicator} - Calcula`;
}
