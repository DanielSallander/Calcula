//! FILENAME: app/extensions/BuiltIn/Encryption/index.ts
// PURPOSE: Workbook encryption UX — File-menu action + encrypt/unlock dialogs.
// CONTEXT: The crypto + host plumbing live in the backend (calcula-crypto,
// persistence). This extension provides the dialogs and registers the password
// prompt that core/lib/file-api calls when opening an encrypted workbook.
// ARCHITECTURE: Uses only the @api facade (The Facade Rule).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { DialogExtensions, registerMenuItem, unregisterMenuItem } from "@api/ui";
import { IconEncrypt } from "@api";
import { workspace } from "@api/system";
import type { PasswordPromptRequest, PasswordPromptResult } from "@api/system";
import { EncryptFileDialog } from "./EncryptFileDialog";
import type { EncryptDialogResult } from "./EncryptFileDialog";
import { UnlockFileDialog } from "./UnlockFileDialog";
import type { UnlockDialogResult } from "./UnlockFileDialog";

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

/** File > "Encrypt with Password…": set, change, or remove the password. */
async function openEncryptDialog(): Promise<void> {
  let alreadyEncrypted = false;
  try {
    alreadyEncrypted = await workspace.isEncrypted();
  } catch {
    alreadyEncrypted = false;
  }

  DialogExtensions.openDialog(ENCRYPT_DIALOG_ID, {
    isEncrypted: alreadyEncrypted,
    onResult: async (result: EncryptDialogResult | null) => {
      if (!result) return;
      try {
        if (result.remove) {
          const ok = window.confirm(
            "Remove the password and save this workbook unencrypted?"
          );
          if (!ok) return;
          await workspace.removePassword();
        } else {
          await workspace.encrypt(result.password, result.remember);
        }
      } catch (error) {
        console.error("[Encryption] action failed:", error);
        alert("Failed to update workbook encryption: " + String(error));
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
  workspace.registerPasswordPrompt(promptUnlock);

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
  workspace.registerPasswordPrompt(null);
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
