//! FILENAME: app/src/core/lib/file-api.ts
import { tracedInvoke } from '../../utils/bridge';
import { open, save } from '@tauri-apps/plugin-dialog';
import { confirmAsync } from './dialogs';
import type { CellData } from '../types/types';
import { emitAppEvent, AppEvents } from './events';
import { checkLifecycleGuards } from './lifecycleGuards';

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
      // Lossy-save consent: .xlsx cannot carry every Calcula feature. Silent
      // destruction on save is the trust-killer — list what will be lost and
      // let the user confirm (or cancel and pick .cala).
      if (path.toLowerCase().endsWith('.xlsx')) {
        const lost = await tracedInvoke<string[]>('xlsx_save_loss_report', {});
        if (lost.length > 0) {
          // AWAITED. The bare `window.confirm` this replaced returned a
          // Promise under Tauri, so `if (!ok)` was `!Promise` — always false.
          // Cancelling the lossy-save warning saved the .xlsx anyway and
          // silently dropped every feature just listed, which is the exact
          // trust-killer the warning exists to prevent.
          const ok = await confirmAsync(
            `Saving as .xlsx will NOT include these Calcula features:\n\n` +
              lost.map((f) => `  • ${f}`).join('\n') +
              `\n\nSave as .xlsx anyway? (Use .cala to keep everything.)`,
            { title: 'Save as .xlsx?', kind: 'warning' },
          );
          if (!ok) return null;
        }
      }
      // Cancellable Before-Save. Guards run BEFORE the BEFORE_SAVE broadcast so
      // a cancelled save never makes subscribers do save-prep work for a save
      // that will not happen. checkLifecycleGuards reports the cancellation to
      // the user (attributed to the script by name) — never a silent no-op.
      // kind: "saveAs" — the user picked a destination. saveFile() falls
      // through to here when the workbook has never been saved, and that IS a
      // Save As (the picker opened), so the flavour is decided by which
      // function runs, not by which one the user clicked.
      if (await checkLifecycleGuards('save', { path, kind: 'saveAs' })) return null;
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
      // Cancellable Before-Save (see saveFileAs). Returning null means "not
      // saved", which every caller already handles as the user-cancelled case.
      if (await checkLifecycleGuards('save', { path: currentPath, kind: 'save' })) return null;
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
      announceBackendStateReplaced();
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

/**
 * Announce that the WHOLE document was replaced, to the four backend-state
 * caches that no per-mutation wrapper can speak for.
 *
 * Outline, hyperlinks, validations and annotations each live in an extension's
 * frontend cache, refreshed when the matching IPC wrapper announces a change.
 * `new_file` and `open_file` change all four at once without going through any
 * of those wrappers, so nothing announced and the caches kept describing the
 * PREVIOUS document.
 *
 * Measured on the running app (2026-08-07): after grouping rows and then
 * File > New, the grid still reserved a 36 px outline gutter for a workbook
 * whose backend reported `maxRowLevel: 0` — a bar for groups that no longer
 * existed, for the rest of the session. `AFTER_NEW` / `AFTER_OPEN` do not
 * cover it: those are workbook-lifecycle events with their own subscribers
 * (script hosts, cell types, custom functions), and the four caches
 * deliberately listen for the state they own rather than for "something
 * happened".
 */
function announceBackendStateReplaced(): void {
  emitAppEvent(AppEvents.OUTLINE_CHANGED, { command: 'document_replaced' });
  emitAppEvent(AppEvents.HYPERLINKS_CHANGED, { sheetIndex: null });
  emitAppEvent(AppEvents.VALIDATIONS_CHANGED, {});
  emitAppEvent(AppEvents.ANNOTATIONS_CHANGED, {});
  // The SHEET LIST is replaced too, and it is the one stale cache the user can
  // click: measured on the running app, a workbook with two sheets followed by
  // File > New left a phantom "Sheet2" tab whose backend index no longer
  // exists, so activating it errors with "Sheet index 1 out of range".
  // `SheetTabs` re-reads on SHEET_CHANGED, which is also literally true here —
  // the active sheet is now the new document's first one.
  emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: '' });
  // The four per-sheet DISPLAY FLAGS (displayZeros / showFormulas / viewMode /
  // displayHeadings) are replaced too, and they are the one backend-state cache
  // the user can SEE from across the room. `new_file` resets all four in Rust and
  // `open_file` loads the document's own — but the renderer reads Core state, fed
  // by the `DISPLAY_*_TOGGLED` intents, so neither reached it. Measured: a
  // workbook saved with the headings hidden, then File > New, kept the headings
  // hidden for the rest of the session while the backend reported them shown.
  //
  // SHEET_CHANGED does not cover it: Core hydrates the flags on the `sheet:
  // normalSwitch` window event that SheetTabs emits, which is a different event
  // with a different meaning (a user picked another tab), and this is not one.
  emitAppEvent(AppEvents.SHEET_DISPLAY_FLAGS_CHANGED);
}

export async function newFile(): Promise<void> {
  try {
    emitAppEvent(AppEvents.BEFORE_NEW);
    await tracedInvoke('new_file', {});
    emitAppEvent(AppEvents.AFTER_NEW);
    announceBackendStateReplaced();
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
