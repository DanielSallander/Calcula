//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/fileOpenUnsavedGuard.test.ts
// PURPOSE: File > Open must not discard unsaved changes without asking.
// CONTEXT: Measured 2026-08-10 (register section 3ba). `fileNew` has always
//          guarded; `fileOpen` never did. Opening replaces the whole document
//          AND resets the undo stack, so one Ctrl+O destroyed unsaved work with
//          no prompt and nothing to undo -- the only document-replacing gesture
//          in the app that did not ask. The window-close handler guards too, so
//          Open was the single hole.
//
//          The ORDER matters as much as the guard: the prompt has to come
//          before the picker, or the user chooses a file and only then learns
//          the choice costs them their edits. `the_prompt_precedes_the_picker`
//          is what pins that, and it is the half a naive fix gets wrong.

import { describe, it, expect, beforeEach, vi } from "vitest";

const isModified = vi.fn();
const open = vi.fn();
const confirmAsync = vi.fn();
const alertAsync = vi.fn();

vi.mock("@api/system", () => ({
  workbook: {
    isModified: (...a: unknown[]) => isModified(...a),
    open: (...a: unknown[]) => open(...a),
    new: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
  },
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
  alertAsync: (...a: unknown[]) => alertAsync(...a),
}));

// The menu icons hang off the @api barrel, which reaches every extension; a
// flat stub keeps that graph out of this test.
vi.mock("@api", () => {
  const Stub = () => null;
  return { IconNew: Stub, IconOpen: Stub, IconSave: Stub, IconSaveAs: Stub };
});

const reload = vi.fn();

describe("File > Open unsaved-changes guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    open.mockResolvedValue([{ row: 0, col: 0, value: "x" }]);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });
  });

  async function fileOpen() {
    const mod = await import("../FileMenu");
    return mod.fileOpen();
  }

  it("asks before opening when the document is modified", async () => {
    isModified.mockResolvedValue(true);
    confirmAsync.mockResolvedValue(true);

    await fileOpen();

    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does NOT open when the user cancels the prompt", async () => {
    isModified.mockResolvedValue(true);
    confirmAsync.mockResolvedValue(false);

    await fileOpen();

    // The whole point: the picker never appears and the document survives.
    expect(open).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not ask when there is nothing to lose", async () => {
    isModified.mockResolvedValue(false);

    await fileOpen();

    expect(confirmAsync).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the prompt precedes the picker", async () => {
    // Asking AFTER the picker is the plausible-looking fix that still wastes
    // the user's choice, so the ordering is asserted, not just the presence.
    const order: string[] = [];
    isModified.mockResolvedValue(true);
    confirmAsync.mockImplementation(async () => {
      order.push("confirm");
      return true;
    });
    open.mockImplementation(async () => {
      order.push("open");
      return [];
    });

    await fileOpen();

    expect(order).toEqual(["confirm", "open"]);
  });

  it("fails CLOSED when the confirm dialog itself rejects", async () => {
    // A guard that throws must not fall through into the destructive path.
    isModified.mockResolvedValue(true);
    confirmAsync.mockRejectedValue(new Error("dialog host gone"));

    await fileOpen();

    expect(open).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
