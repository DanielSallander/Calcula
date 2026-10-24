//! FILENAME: app/extensions/BuiltIn/Encryption/__tests__/encryptionSaveRefusal.test.ts
// PURPOSE: Encrypting (or removing the password from) a workbook ends in a
//          SAVE, so its failure message says the backend's retryable refusal in
//          plain words -- never its internal code -- and every other failure as
//          it always read, awaited.
// CONTEXT: `workbook.encrypt` / `workbook.removePassword` call the same
//          save_file as Ctrl+S (core/lib/file-api.ts), which Rust refuses with
//          "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was
//          being saved -- ..." when a sheet renumbering kept landing inside its
//          snapshot. The alert printed `String(error)`. Driven here through the
//          real extension: activate, the File-menu item, the dialog's onResult.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  menuItems: [] as { id: string; action?: () => unknown }[],
  openDialog: vi.fn(),
  isEncrypted: vi.fn(),
  encrypt: vi.fn(),
  removePassword: vi.fn(),
  confirmAsync: vi.fn(),
  alertAsync: vi.fn(),
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: {
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
    openDialog: (...a: unknown[]) => h.openDialog(...a),
  },
  registerMenuItem: (_menu: string, item: { id: string; action?: () => unknown }) => {
    h.menuItems.push(item);
  },
  unregisterMenuItem: vi.fn(),
}));
vi.mock("@api", () => ({ IconEncrypt: () => null }));
vi.mock("@api/system", () => ({
  workbook: {
    isEncrypted: (...a: unknown[]) => h.isEncrypted(...a),
    encrypt: (...a: unknown[]) => h.encrypt(...a),
    removePassword: (...a: unknown[]) => h.removePassword(...a),
    registerPasswordPrompt: vi.fn(),
  },
}));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => h.confirmAsync(...a),
  alertAsync: (...a: unknown[]) => h.alertAsync(...a),
}));
vi.mock("../EncryptFileDialog", () => ({ EncryptFileDialog: () => null }));
vi.mock("../UnlockFileDialog", () => ({ UnlockFileDialog: () => null }));

import extension, {
  REMOVE_REFUSED_NOW_UNENCRYPTED,
  REMOVE_REFUSED_STILL_ENCRYPTED,
  encryptionFailureMessage,
  removePasswordFailureMessage,
} from "../index";

const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being saved -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const PLAIN =
  "The workbook changed while it was being saved -- a sheet was added, deleted or moved during " +
  "each of 3 attempts to read it. Nothing was written; try again.";
const CODE = "WORKBOOK_CHANGED_WHILE_SAVING";

type OnResult = (result: { remove: boolean; password: string; remember: boolean } | null) => Promise<void>;

/** File > Encrypt with Password..., then the dialog's answer; resolves when the extension is done with it. */
async function encryptThrough(result: { remove: boolean; password: string; remember: boolean }): Promise<void> {
  const item = h.menuItems.find((m) => m.id === "file.encrypt");
  expect(item, "the File-menu item is gone").toBeTruthy();
  await item!.action!();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(h.openDialog).toHaveBeenCalled();
  const data = h.openDialog.mock.calls[h.openDialog.mock.calls.length - 1][1] as { onResult: OnResult };
  await data.onResult(result);
}

beforeEach(() => {
  h.menuItems.length = 0;
  h.openDialog.mockReset();
  h.isEncrypted.mockReset().mockResolvedValue(false);
  h.encrypt.mockReset();
  h.removePassword.mockReset();
  h.confirmAsync.mockReset().mockResolvedValue(true);
  h.alertAsync.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  extension.deactivate?.();
  extension.activate({} as never);
});

describe("an encryption whose save was refused reads as a sentence", () => {
  // SABOTAGE: `String(error)` back in encryptionFailureMessage.
  it("encrypt: the plain sentence, never the code", async () => {
    h.encrypt.mockRejectedValue(REFUSAL);
    await encryptThrough({ remove: false, password: "pw", remember: false });
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    const shown = String(h.alertAsync.mock.calls[0][0]);
    expect(shown).toBe(`Failed to update workbook encryption: ${PLAIN}`);
    expect(shown).not.toContain(CODE);
  });

  // A refused Remove Password says the same sentence AND where the encryption
  // now stands, read from the backend after the failure (review round 8: the
  // passphrase stayed off while the message said nothing was written).
  // SABOTAGE: always say "still encrypted" (never ask isEncrypted) -- the
  // second case fails; always say "no longer" -- the first fails.
  it("remove password, passphrase put back: the sentence, and that the workbook is still encrypted", async () => {
    h.isEncrypted.mockReset().mockResolvedValue(true);
    h.removePassword.mockRejectedValue(new Error(REFUSAL));
    await encryptThrough({ remove: true, password: "", remember: false });
    expect(h.alertAsync).toHaveBeenCalledWith(
      `Failed to update workbook encryption: ${PLAIN} ${REMOVE_REFUSED_STILL_ENCRYPTED}`,
    );
    // Once to open the dialog, once AFTER the failure to say where it stands.
    expect(h.isEncrypted).toHaveBeenCalledTimes(2);
  });

  it("remove password, passphrase NOT put back: says the open workbook is unencrypted and the file is not", async () => {
    h.isEncrypted.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    h.removePassword.mockRejectedValue(REFUSAL);
    await encryptThrough({ remove: true, password: "", remember: false });
    expect(h.alertAsync).toHaveBeenCalledWith(
      `Failed to update workbook encryption: ${PLAIN} ${REMOVE_REFUSED_NOW_UNENCRYPTED}`,
    );
  });

  it("the two state sentences say what the next save does", () => {
    expect(REMOVE_REFUSED_STILL_ENCRYPTED).toMatch(/still encrypted, in this window and in the file on disk/);
    expect(REMOVE_REFUSED_NOW_UNENCRYPTED).toMatch(/file on disk is still encrypted/);
    expect(REMOVE_REFUSED_NOW_UNENCRYPTED).toMatch(/next save writes it without a password/);
    expect(removePasswordFailureMessage("disk full", true)).toBe(
      `Failed to update workbook encryption: disk full ${REMOVE_REFUSED_STILL_ENCRYPTED}`,
    );
  });

  it("every other failure reads exactly as before", () => {
    for (const err of [new Error("disk full"), "access denied"]) {
      expect(encryptionFailureMessage(err)).toBe(`Failed to update workbook encryption: ${String(err)}`);
    }
  });

  // SABOTAGE: `void alertAsync(...)` -- the handler then finishes while the
  // message is still up.
  it("the message is awaited", async () => {
    let dismiss: () => void = () => {};
    h.alertAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve;
        }),
    );
    h.encrypt.mockRejectedValue(REFUSAL);
    let settled = false;
    const running = encryptThrough({ remove: false, password: "pw", remember: false }).then(() => {
      settled = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    expect(settled, "the handler finished before its message was dismissed").toBe(false);
    dismiss();
    await running;
    expect(settled).toBe(true);
  });
});
