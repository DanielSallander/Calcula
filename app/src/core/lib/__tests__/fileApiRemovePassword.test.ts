//! FILENAME: app/src/core/lib/__tests__/fileApiRemovePassword.test.ts
// PURPOSE: Remove Password never leaves the workbook in this window and the
//          file on disk disagreeing about encryption (review round 8, F5).
// CONTEXT: Rust takes the passphrase off the session BEFORE the save that
//          writes the file unencrypted (`clear_session_password`, then
//          `save_file` with none), and that save can be refused -- by a
//          Before-Save guard, or with the retryable snapshot refusal while an
//          agent keeps moving sheets. The passphrase used to stay off: the
//          workbook here was unencrypted, the file on disk was not, the dialog
//          then offered to SET a password, and the next ordinary save wrote
//          plain text although the message had said nothing was written.
//
//          The backend is doubled at the Tauri boundary (`tracedInvoke`) as a
//          small model of what Rust keeps: the session passphrase (what
//          `is_document_encrypted` reports and the next save encrypts with),
//          the passphrase remembered in the keychain, and what the file on disk
//          holds. `save_file` behaves as Rust's does: an explicit password
//          wins, otherwise the session's, and nothing is written when refused.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tracedInvoke = vi.fn();
vi.mock("../../../utils/bridge", () => ({ tracedInvoke: (...a: unknown[]) => tracedInvoke(...a) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../dialogs", () => ({ confirmAsync: vi.fn(async () => true) }));

import { isDocumentEncrypted, removeFilePassword, ENCRYPTION_STATE_CHANGED } from "../file-api";
import { onAppEvent } from "../events";
import { registerLifecycleCancelReporter, registerLifecycleGuard, resetLifecycleGuards } from "../lifecycleGuards";

/** The refusal exactly as Rust formats it for the save door. */
const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being saved -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const PATH = "C:/Books/Secret.cala";
const PASSPHRASE = "correct horse battery staple";

/** What the doubled backend holds. */
let session: string | null;
let remembered: string | null;
let disk: { encryptedWith: string | null };
/** What each coming save_file answers: a string REFUSES with it (bare, as Tauri does). */
let saveAnswers: (string | undefined)[];
const announced: string[] = [];
const offs: (() => void)[] = [];

const calls = (): string[] => tracedInvoke.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  session = PASSPHRASE;
  remembered = PASSPHRASE;
  disk = { encryptedWith: PASSPHRASE };
  saveAnswers = [];
  announced.length = 0;
  tracedInvoke.mockReset().mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_current_file_path":
        return PATH;
      case "xlsx_save_loss_report":
        return [];
      case "is_document_encrypted":
        return session !== null;
      case "keychain_get_password":
        return args?.path === PATH ? remembered : null;
      case "keychain_delete_password":
        if (args?.path === PATH) remembered = null;
        return undefined;
      case "clear_session_password":
        session = null;
        return undefined;
      case "set_session_password":
        session = String(args?.password);
        return undefined;
      case "save_file": {
        const answer = saveAnswers.shift();
        if (typeof answer === "string") throw answer;
        const password = (args?.password as string | undefined) ?? session;
        disk = { encryptedWith: password };
        session = password;
        return undefined;
      }
      default:
        return undefined;
    }
  });
  resetLifecycleGuards();
  registerLifecycleCancelReporter(() => {});
  offs.push(onAppEvent(ENCRYPTION_STATE_CHANGED, () => announced.push(ENCRYPTION_STATE_CHANGED)));
});

afterEach(() => {
  while (offs.length > 0) offs.pop()!();
  resetLifecycleGuards();
});

describe("Remove Password", () => {
  it("writes the file unencrypted, and only then forgets the remembered passphrase", async () => {
    await expect(removeFilePassword()).resolves.toBe(PATH);
    expect(disk.encryptedWith, "the file on disk is still encrypted").toBeNull();
    await expect(isDocumentEncrypted()).resolves.toBe(false);
    expect(remembered, "the remembered passphrase outlived the removal").toBeNull();
    expect(calls()).not.toContain("set_session_password");
    expect(announced).toContain(ENCRYPTION_STATE_CHANGED);
  });

  // SABOTAGE: drop the `set_session_password` put-back from removeFilePassword.
  it("a refused save puts the passphrase back: encrypted here AND on disk, so the two agree", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    saveAnswers.push(REFUSAL);
    await expect(removeFilePassword()).rejects.toBe(REFUSAL);
    // The file on disk was never touched...
    expect(disk.encryptedWith).toBe(PASSPHRASE);
    // ...and the workbook here is encrypted again, with the same passphrase,
    // so the dialog offers Remove again and the next save stays encrypted.
    await expect(isDocumentEncrypted(), "the open workbook was left unencrypted").resolves.toBe(true);
    expect(session).toBe(PASSPHRASE);
    expect(remembered, "a refused removal forgot the remembered passphrase").toBe(PASSPHRASE);
    const order = calls();
    expect(order.indexOf("set_session_password")).toBeGreaterThan(order.indexOf("save_file"));
    expect(announced, "the encryption state was not announced after the refusal").toEqual([ENCRYPTION_STATE_CHANGED]);

    // The next ordinary save writes what the user now has: an encrypted file.
    saveAnswers.length = 0;
    await tracedInvoke("save_file", { path: PATH, password: undefined });
    expect(disk.encryptedWith, "the next save wrote plain text after a refused removal").toBe(PASSPHRASE);
  });

  // SABOTAGE: clear the session passphrase BEFORE prepareSave (the old order).
  it("a Before-Save guard that refuses leaves everything as it was: nothing cleared, nothing forgotten", async () => {
    registerLifecycleGuard(async () => ({ by: "Totals", reason: "Fill in the total first" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(removeFilePassword()).resolves.toBeNull();
    expect(calls(), "the passphrase was taken off for a save that never ran").not.toContain("clear_session_password");
    await expect(isDocumentEncrypted()).resolves.toBe(true);
    expect(remembered, "a cancelled removal forgot the remembered passphrase").toBe(PASSPHRASE);
    expect(disk.encryptedWith).toBe(PASSPHRASE);
  });

  it("a passphrase that was not remembered cannot be put back: the refusal propagates, and the state says so", async () => {
    remembered = null;
    saveAnswers.push(REFUSAL);
    await expect(removeFilePassword()).rejects.toBe(REFUSAL);
    expect(calls()).not.toContain("set_session_password");
    // What the caller reads to tell the user (the Encryption extension's message).
    await expect(isDocumentEncrypted()).resolves.toBe(false);
    expect(disk.encryptedWith).toBe(PASSPHRASE);
  });
});
