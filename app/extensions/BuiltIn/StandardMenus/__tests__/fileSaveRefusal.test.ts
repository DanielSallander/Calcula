//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/fileSaveRefusal.test.ts
// PURPOSE: File > Save and Save As say the backend's RETRYABLE refusal in plain
//          words -- never its internal code -- leave every other failure as it
//          always read, and AWAIT the message.
// CONTEXT: Rust refuses `save_file` with "WORKBOOK_CHANGED_WHILE_SAVING: the
//          workbook changed while it was being saved -- ..." when a sheet
//          renumbering (an agent deleting or moving sheets) kept landing inside
//          its snapshot (persistence.rs `take_consistent_snapshot`). Nothing was
//          written. The Save alert printed `String(error)`, so the user read the
//          raw code. The ONE recogniser is @api/backendRefusal (pinned against
//          Rust by src/api/__tests__/backendRefusal.test.ts). The dialogs are
//          doubled in their real ASYNC shape, so "awaited" is a claim this file
//          can falsify.

import { describe, it, expect, beforeEach, vi } from "vitest";

const save = vi.fn();
const saveAs = vi.fn();
const alertAsync = vi.fn();

vi.mock("@api/system", () => ({
  workbook: {
    isModified: vi.fn(),
    open: vi.fn(),
    new: vi.fn(),
    save: (...a: unknown[]) => save(...a),
    saveAs: (...a: unknown[]) => saveAs(...a),
  },
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: vi.fn(),
  alertAsync: (...a: unknown[]) => alertAsync(...a),
}));

// The menu icons hang off the @api barrel, which reaches every extension; a
// flat stub keeps that graph out of this test.
vi.mock("@api", () => {
  const Stub = () => null;
  return { IconNew: Stub, IconOpen: Stub, IconSave: Stub, IconSaveAs: Stub };
});

import { fileSave, fileSaveAs, saveFailureMessage } from "../FileMenu";

/** The refusal exactly as Rust formats it for the save door. */
const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being saved -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const PLAIN =
  "The workbook changed while it was being saved -- a sheet was added, deleted or moved during " +
  "each of 3 attempts to read it. Nothing was written; try again.";
const CODE = "WORKBOOK_CHANGED_WHILE_SAVING";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  alertAsync.mockResolvedValue(undefined);
});

describe("a refused Save reads as a sentence", () => {
  // SABOTAGE: `String(error)` back in saveFailureMessage.
  for (const [name, run, door] of [
    ["Save", fileSave, save],
    ["Save As", fileSaveAs, saveAs],
  ] as const) {
    it(`${name}: the plain sentence, never the code`, async () => {
      door.mockRejectedValue(REFUSAL);
      await run();
      expect(alertAsync).toHaveBeenCalledTimes(1);
      const shown = String(alertAsync.mock.calls[0][0]);
      expect(shown).toBe(`Failed to save file: ${PLAIN}`);
      expect(shown, "the raw code reached the screen").not.toContain(CODE);
    });
  }

  it("an Error-wrapped refusal reads the same", () => {
    expect(saveFailureMessage(new Error(REFUSAL))).toBe(`Failed to save file: ${PLAIN}`);
  });
});

describe("every other failure reads exactly as it always did", () => {
  it("is 'Failed to save file: ' + String(error)", async () => {
    for (const err of [new Error("disk full"), "access denied", "CALP_SOMETHING: else"]) {
      alertAsync.mockClear();
      save.mockRejectedValue(err);
      await fileSave();
      expect(alertAsync).toHaveBeenCalledWith(`Failed to save file: ${String(err)}`);
    }
  });

  it("a save that succeeds or is cancelled says nothing", async () => {
    save.mockResolvedValue("C:/Books/Budget.cala");
    await fileSave();
    saveAs.mockResolvedValue(null);
    await fileSaveAs();
    expect(alertAsync).not.toHaveBeenCalled();
  });
});

describe("the message is AWAITED", () => {
  // SABOTAGE: `void alertAsync(...)` -- the command then settles while the
  // message is still on screen.
  it("Save does not settle until the message is dismissed", async () => {
    let dismiss: () => void = () => {};
    alertAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve;
        }),
    );
    save.mockRejectedValue(REFUSAL);
    let settled = false;
    const running = fileSave().then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(alertAsync).toHaveBeenCalledTimes(1);
    expect(settled, "Save settled before its message was dismissed").toBe(false);
    dismiss();
    await running;
    expect(settled).toBe(true);
  });
});
