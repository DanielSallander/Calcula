/**
 * Workbook encryption E2E tests.
 *
 * Exercises the opt-in whole-file `.cala` encryption end to end through the
 * backend commands (save_file / open_file with a password, the session-password
 * + is_document_encrypted state, and the Windows Credential Manager keychain).
 *
 * Native OS file dialogs can't be driven by Playwright, so — like the soak
 * save/reload oracle — these tests invoke the Tauri commands directly via
 * window.__TAURI__.core.invoke() with explicit temp paths. Round-trip integrity
 * is checked with the same workbook digest the soak oracle uses, and the bytes
 * on disk are inspected from Node to prove real encryption (not just a flag).
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { getWorkbookDigest, diffDigests } from "../oracles/digest";

// A passphrase with a non-ASCII character, to exercise UTF-8 handling through
// both the crypto layer and the keychain.
const PW = "Tr0ub4dor&3-Σ";

const ENC_MAGIC = "CALAENC1"; // calcula-crypto container magic (first 8 bytes)

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `calcula-e2e-enc-${name}.cala`);
}

/** First 8 bytes of a file as a latin1 string (for magic-byte assertions). */
function fileMagic(filePath: string): string {
  return fs.readFileSync(filePath).subarray(0, 8).toString("latin1");
}

async function invoke<T = unknown>(
  page: Page,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(c, a);
    },
    { c: cmd, a: args }
  ) as Promise<T>;
}

/** save_file, omitting the password field entirely when none is given. */
async function saveFile(page: Page, filePath: string, password?: string): Promise<void> {
  await page.evaluate(
    async ({ p, pw }) => {
      const tauri = (window as any).__TAURI__;
      const args: Record<string, unknown> = { path: p };
      if (pw !== undefined) args.password = pw;
      await tauri.core.invoke("save_file", args);
    },
    { p: filePath, pw: password }
  );
}

/** open_file that captures the sentinel error string instead of throwing. */
async function tryOpen(
  page: Page,
  filePath: string,
  password?: string
): Promise<{ ok: boolean; error: string | null }> {
  return page.evaluate(
    async ({ p, pw }) => {
      const tauri = (window as any).__TAURI__;
      const args: Record<string, unknown> = { path: p };
      if (pw !== undefined) args.password = pw;
      try {
        await tauri.core.invoke("open_file", args);
        window.dispatchEvent(new Event("grid:refresh"));
        return { ok: true, error: null };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    { p: filePath, pw: password }
  );
}

test.describe("Workbook encryption", () => {
  const createdFiles: string[] = [];

  test.afterEach(async ({ grid }) => {
    // Prevent cross-test contamination: drop the session passphrase so a later
    // plain save can't accidentally inherit encryption, and forget keychain
    // entries + delete temp files created during the test.
    await grid.page.evaluate(async (paths: string[]) => {
      const tauri = (window as any).__TAURI__;
      try {
        await tauri.core.invoke("clear_session_password");
      } catch {
        /* ignore */
      }
      for (const p of paths) {
        try {
          await tauri.core.invoke("keychain_delete_password", { path: p });
        } catch {
          /* ignore */
        }
      }
    }, createdFiles);
    for (const p of createdFiles) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    createdFiles.length = 0;
  });

  test("encrypts on disk and round-trips with the correct password", async ({ grid }) => {
    const file = tmpFile("roundtrip");
    createdFiles.push(file);

    await grid.setCellValueDirect("BC10", "TopSecret");
    await grid.setCellValueDirect("BC11", "424242");

    await saveFile(grid.page, file, PW);
    await grid.page.waitForTimeout(300);

    // The document is flagged encrypted...
    expect(await invoke<boolean>(grid.page, "is_document_encrypted")).toBe(true);
    // ...and the bytes on disk are a real encryption container, not a plain ZIP.
    expect(fileMagic(file)).toBe(ENC_MAGIC);

    // Baseline AFTER save (save may recalc), then reload from the encrypted file
    // and assert the whole-workbook digest is unchanged across the round-trip.
    const before = await getWorkbookDigest(grid.page);
    const opened = await tryOpen(grid.page, file, PW);
    expect(opened.ok, opened.error ?? "").toBe(true);
    await grid.page.waitForTimeout(500);

    const after = await getWorkbookDigest(grid.page);
    const diff = diffDigests(before, after, "saveReload");
    expect(
      diff.equal,
      diff.equal ? "" : `first diff: ${JSON.stringify(diff.diffs[0])}`
    ).toBe(true);
  });

  test("plain save is not encrypted on disk", async ({ grid }) => {
    const file = tmpFile("plain");
    createdFiles.push(file);

    await grid.setCellValueDirect("BC12", "PlainData");
    await saveFile(grid.page, file); // no password
    await grid.page.waitForTimeout(300);

    expect(await invoke<boolean>(grid.page, "is_document_encrypted")).toBe(false);
    const magic = fileMagic(file);
    expect(magic.startsWith("PK")).toBe(true); // ZIP local-file header
    expect(magic).not.toBe(ENC_MAGIC);
  });

  test("wrong password is rejected (ENC_WRONG_PASSWORD)", async ({ grid }) => {
    const file = tmpFile("wrongpw");
    createdFiles.push(file);

    await grid.setCellValueDirect("BC13", "Guarded");
    await saveFile(grid.page, file, PW);
    await grid.page.waitForTimeout(300);

    const res = await tryOpen(grid.page, file, "definitely-not-the-password");
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("ENC_WRONG_PASSWORD");
  });

  test("missing password is rejected (ENC_NEEDS_PASSWORD)", async ({ grid }) => {
    const file = tmpFile("nopw");
    createdFiles.push(file);

    await grid.setCellValueDirect("BC14", "Guarded2");
    await saveFile(grid.page, file, PW);
    await grid.page.waitForTimeout(300);

    const res = await tryOpen(grid.page, file); // omit password entirely
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("ENC_NEEDS_PASSWORD");
  });

  test("removing the password produces a plain, password-free workbook", async ({ grid }) => {
    const file = tmpFile("remove");
    createdFiles.push(file);

    await grid.setCellValueDirect("BC15", "WasSecret");

    // Encrypt first.
    await saveFile(grid.page, file, PW);
    await grid.page.waitForTimeout(300);
    expect(fileMagic(file)).toBe(ENC_MAGIC);

    // Remove the password: clear the session passphrase, then re-save. With no
    // explicit password and an empty session, the save falls back to plain.
    await invoke(grid.page, "clear_session_password");
    await saveFile(grid.page, file);
    await grid.page.waitForTimeout(300);

    expect(await invoke<boolean>(grid.page, "is_document_encrypted")).toBe(false);
    expect(fileMagic(file).startsWith("PK")).toBe(true);

    // It now opens with no password.
    const res = await tryOpen(grid.page, file);
    expect(res.ok, res.error ?? "").toBe(true);
  });

  test("keychain remembers and forgets a workbook passphrase", async ({ grid }) => {
    const file = tmpFile("keychain");
    createdFiles.push(file);

    await invoke(grid.page, "keychain_set_password", { path: file, password: PW });
    expect(await invoke<boolean>(grid.page, "keychain_has_password", { path: file })).toBe(true);
    expect(await invoke<string | null>(grid.page, "keychain_get_password", { path: file })).toBe(PW);

    await invoke(grid.page, "keychain_delete_password", { path: file });
    expect(await invoke<boolean>(grid.page, "keychain_has_password", { path: file })).toBe(false);
  });
});
