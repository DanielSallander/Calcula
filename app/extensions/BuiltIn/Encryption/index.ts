//! FILENAME: app/extensions/BuiltIn/Encryption/index.ts
// PURPOSE: Workbook encryption UX — File-menu action + encrypt/unlock dialogs.
// CONTEXT: The crypto + host plumbing live in the backend (calcula-crypto,
// persistence). This extension provides the dialogs and registers the password
// prompt that core/lib/file-api calls when opening an encrypted workbook.
// ARCHITECTURE: Uses only the @api facade (The Facade Rule).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { DialogExtensions, registerMenuItem, unregisterMenuItem } from "@api/ui";
import { IconEncrypt } from "@api";
import { workbook } from "@api/system";
import type { PasswordPromptRequest, PasswordPromptResult } from "@api/system";
import { EncryptFileDialog } from "./EncryptFileDialog";
import type { EncryptDialogResult } from "./EncryptFileDialog";
import { UnlockFileDialog } from "./UnlockFileDialog";
import type { UnlockDialogResult } from "./UnlockFileDialog";
import { confirmAsync, alertAsync } from "@api/dialogs";
import { describeBackendRefusal } from "@api/backendRefusal";

const ENCRYPT_DIALOG_ID = "encrypt-file";
const UNLOCK_DIALOG_ID = "unlock-file";
const MENU_ITEM_ID = "file.encrypt";

let isActivated = false;

function baseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

/**
 * Open-time password prompt. Registered with core so the open re-prompt loop in
 * file-api can ask the user for a passphrase via the UnlockFileDialog.
 */
function promptUnlock(
  req: PasswordPromptRequest
): Promise<PasswordPromptResult | null> {
  return new Promise((resolve) => {
    DialogExtensions.openDialog(UNLOCK_DIALOG_ID, {
      fileName: baseName(req.path),
      errorKind: req.errorKind,
      onResult: (result: UnlockDialogResult | null) => resolve(result),
    });
  });
}

/**
 * What a failed encrypt / remove-password tells the user. Both end in a save,
 * so the backend's RETRYABLE refusal -- the workbook changed while it was
 * being saved, so nothing was written -- reads as its plain sentence, never
 * its internal code; every other error reads exactly as it always did
 * (`@api/backendRefusal`).
 */
export function encryptionFailureMessage(error: unknown): string {
  return "Failed to update workbook encryption: " + describeBackendRefusal(error);
}

/** Said when a refused Remove Password left the workbook encrypted, here and on disk. */
export const REMOVE_REFUSED_STILL_ENCRYPTED =
  "The password was not removed: the workbook is still encrypted, in this window and in the file on disk.";

/** Said when a refused Remove Password could not put the passphrase back on the open workbook. */
export const REMOVE_REFUSED_NOW_UNENCRYPTED =
  "The password is no longer on the workbook open in this window, but the file on disk is still " +
  "encrypted. The next save writes it without a password; to keep it encrypted, set the password " +
  "again (File > Encrypt with Password).";

/**
 * What a failed Remove Password tells the user: the failure, AND where the
 * encryption stands now -- read from the backend after the failure, never
 * assumed. `workbook.removePassword` puts the passphrase back when the save
 * that would write the file unencrypted is refused and the passphrase is
 * remembered on this computer; when it is not, the open workbook stays
 * unencrypted while the file on disk is still encrypted, and the user must be
 * told which, because the next save differs (review round 8).
 */
export function removePasswordFailureMessage(error: unknown, stillEncrypted: boolean): string {
  return (
    encryptionFailureMessage(error) +
    " " +
    (stillEncrypted ? REMOVE_REFUSED_STILL_ENCRYPTED : REMOVE_REFUSED_NOW_UNENCRYPTED)
  );
}

/** File > "Encrypt with Password…": set, change, or remove the password. */
async function openEncryptDialog(): Promise<void> {
  let alreadyEncrypted = false;
  try {
    alreadyEncrypted = await workbook.isEncrypted();
  } catch {
    alreadyEncrypted = false;
  }

  DialogExtensions.openDialog(ENCRYPT_DIALOG_ID, {
    isEncrypted: alreadyEncrypted,
    onResult: async (result: EncryptDialogResult | null) => {
      if (!result) return;
      try {
        if (result.remove) {
          // AWAITED. `!ok` on a Promise was always false, so Cancel stripped
          // the password and rewrote the workbook in plaintext anyway.
          const ok = await confirmAsync(
            "Remove the password and save this workbook unencrypted?",
            { title: "Remove encryption?", kind: "warning" },
          );
          if (!ok) return;
          try {
            await workbook.removePassword();
          } catch (error) {
            console.error("[Encryption] remove password failed:", error);
            // WHERE IT STANDS NOW, asked of the backend: still encrypted (the
            // passphrase was put back) or not (it could not be).
            let stillEncrypted = false;
            try {
              stillEncrypted = await workbook.isEncrypted();
            } catch {
              stillEncrypted = false;
            }
            await alertAsync(removePasswordFailureMessage(error, stillEncrypted));
          }
        } else {
          await workbook.encrypt(result.password, result.remember);
        }
      } catch (error) {
        console.error("[Encryption] action failed:", error);
        await alertAsync(encryptionFailureMessage(error));
      }
    },
  });
}

function activate(_context: ExtensionContext): void {
  if (isActivated) return;

  DialogExtensions.registerDialog({
    id: ENCRYPT_DIALOG_ID,
    component: EncryptFileDialog,
    priority: 210,
  });
  DialogExtensions.registerDialog({
    id: UNLOCK_DIALOG_ID,
    component: UnlockFileDialog,
    priority: 220,
  });

  // The open flow (file-api) calls this hook when it hits an encrypted file.
  workbook.registerPasswordPrompt(promptUnlock);

  registerMenuItem("file", {
    id: MENU_ITEM_ID,
    label: "Encrypt with Password…",
    icon: IconEncrypt,
    action: () => {
      void openEncryptDialog();
    },
  });

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;
  DialogExtensions.unregisterDialog(ENCRYPT_DIALOG_ID);
  DialogExtensions.unregisterDialog(UNLOCK_DIALOG_ID);
  workbook.registerPasswordPrompt(null);
  unregisterMenuItem("file", MENU_ITEM_ID);
  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.encryption",
    name: "Workbook Encryption",
    version: "1.0.0",
    description:
      "Opt-in whole-file password encryption for .cala workbooks (XChaCha20-Poly1305 + Argon2id), with keychain remember-on-this-machine.",
  },
  activate,
  deactivate,
};

export default extension;
