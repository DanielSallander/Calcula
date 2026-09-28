//! FILENAME: app/src/core/lib/__tests__/dialogs.test.ts
// PURPOSE: Lock the contract of the dialog wrappers that replaced the raw
//          window.confirm / window.alert / window.prompt globals.
// CONTEXT: The defect these retire shipped SIX times. Every test below is
//          written against the TAURI shape of the global — a Promise-returning
//          confirm — because that is the shape no previous test used, and the
//          reason the bug kept passing review: jsdom's confirm is synchronous,
//          so a `mockReturnValue(false)` double made the broken
//          `if (!window.confirm(m))` guard look like it worked.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// The plugin, for the Tauri-path cases (window.__TAURI_INTERNALS__ present).
const tauriConfirm = vi.fn();
const tauriMessage = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...a: unknown[]) => tauriConfirm(...a),
  message: (...a: unknown[]) => tauriMessage(...a),
}));

import {
  confirmAsync,
  confirmOutcomeAsync,
  askSaveDiscardCancelAsync,
  alertAsync,
  promptAsync,
  PROMPT_DIALOG_ATTR,
} from "../dialogs";
import * as apiDialogs from "../../../api/dialogs";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("confirmAsync", () => {
  // THE REGRESSION. Under Tauri the global resolves a Promise; the old
  // `if (!window.confirm(msg)) return;` tested `!Promise` — always false.
  it("resolves FALSE when a Promise-returning confirm (the Tauri shape) resolves false", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(Promise.resolve(false) as unknown as boolean);
    expect(await confirmAsync("Delete everything?")).toBe(false);
  });

  it("resolves TRUE when a Promise-returning confirm resolves true", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(Promise.resolve(true) as unknown as boolean);
    expect(await confirmAsync("Delete everything?")).toBe(true);
  });

  it("still works against the SYNCHRONOUS browser shape (jsdom / browser smoke)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await confirmAsync("q")).toBe(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await confirmAsync("q")).toBe(true);
  });

  // FAIL CLOSED. A consent gate must be able to read "no answer" as "no".
  it("resolves FALSE when the dialog throws", async () => {
    vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("no dialog surface");
    });
    expect(await confirmAsync("q")).toBe(false);
  });

  it("resolves FALSE when the dialog rejects", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(
      Promise.reject(new Error("ipc down")) as unknown as boolean,
    );
    expect(await confirmAsync("q")).toBe(false);
  });

  // Anything that is not an explicit `true` is a refusal — a shim that resolves
  // undefined (window closed) must never read as consent.
  it("resolves FALSE for a non-boolean resolution", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(Promise.resolve(undefined) as unknown as boolean);
    expect(await confirmAsync("q")).toBe(false);
    vi.spyOn(window, "confirm").mockReturnValue("yes" as unknown as boolean);
    expect(await confirmAsync("q")).toBe(false);
  });
});

// THREE outcomes, for the question where "no" ACTS too (the close prompt's
// "Don't Save" discards the document): "could not ask" must be told apart.
describe("confirmOutcomeAsync", () => {
  it("jsdom shape: confirmed / declined / unavailable", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await confirmOutcomeAsync("q")).toBe("confirmed");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await confirmOutcomeAsync("q")).toBe("declined");
    vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("no dialog surface");
    });
    expect(await confirmOutcomeAsync("q")).toBe("unavailable");
  });

  describe("under Tauri (the plugin's confirm)", () => {
    const w = window as unknown as Record<string, unknown>;
    afterEach(() => {
      delete w.__TAURI_INTERNALS__;
      tauriConfirm.mockReset();
    });

    it("a dialog that cannot be shown is UNAVAILABLE, never declined -- and confirmAsync still reads it as no", async () => {
      w.__TAURI_INTERNALS__ = {};
      tauriConfirm.mockRejectedValue(new Error("a modal is already open"));
      const options = { okLabel: "Save", cancelLabel: "Don't Save" };
      expect(await confirmOutcomeAsync("Save changes?", options)).toBe("unavailable");
      expect(await confirmAsync("Save changes?")).toBe(false);
    });

    it("the refusing button is DECLINED; the affirmative is CONFIRMED; the options reach the plugin", async () => {
      w.__TAURI_INTERNALS__ = {};
      tauriConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const options = { title: "Calcula", kind: "warning" as const, okLabel: "Save", cancelLabel: "Don't Save" };
      expect(await confirmOutcomeAsync("q", options)).toBe("declined");
      expect(await confirmOutcomeAsync("q")).toBe("confirmed");
      expect(tauriConfirm.mock.calls[0][1]).toEqual(options);
    });
  });
});

// THREE buttons, FOUR outcomes: the close prompt. Every double below is the
// TAURI shape of the plugin's `message` with YesNoCancel custom buttons, which
// resolves the clicked button's LABEL -- and the CANCEL label for the X
// button, Escape and Alt+F4 (the pinned plugin/rfd lines are cited above
// askSaveDiscardCancelAsync in ../dialogs.ts). The two-button box this
// replaced read X and Escape as "Don't Save" and destroyed the window.
describe("askSaveDiscardCancelAsync", () => {
  const w = window as unknown as Record<string, unknown>;
  const labels = { saveLabel: "Save", discardLabel: "Don't Save", cancelLabel: "Cancel" };

  beforeEach(() => {
    w.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete w.__TAURI_INTERNALS__;
    tauriMessage.mockReset();
  });

  it("is reachable through @api/dialogs, the path Shell and Extensions use", () => {
    expect(apiDialogs.askSaveDiscardCancelAsync).toBe(askSaveDiscardCancelAsync);
  });

  it("Save is SAVE, and the labels reach the plugin as YesNoCancel custom buttons", async () => {
    tauriMessage.mockResolvedValue("Save");
    const options = { title: "Calcula", kind: "warning" as const, ...labels };
    expect(await askSaveDiscardCancelAsync("Save changes?", options)).toBe("save");
    expect(tauriMessage).toHaveBeenCalledTimes(1);
    expect(tauriMessage).toHaveBeenCalledWith("Save changes?", {
      title: "Calcula",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
  });

  it("an explicit Don't Save click is DISCARD", async () => {
    tauriMessage.mockResolvedValue("Don't Save");
    expect(await askSaveDiscardCancelAsync("q", labels)).toBe("discard");
  });

  // THE REGRESSION. X, Escape and Alt+F4 come back as the cancel label.
  it("the Cancel button, the X button and Escape are CANCEL, never discard", async () => {
    tauriMessage.mockResolvedValue("Cancel");
    expect(await askSaveDiscardCancelAsync("q", labels)).toBe("cancel");
  });

  it("with a custom cancel label a dismissal is CANCEL, relabelled by the plugin or not", async () => {
    const options = { ...labels, cancelLabel: "Keep Editing" };
    tauriMessage.mockResolvedValueOnce("Keep Editing").mockResolvedValueOnce("Cancel");
    expect(await askSaveDiscardCancelAsync("q", options)).toBe("cancel");
    expect(await askSaveDiscardCancelAsync("q", options)).toBe("cancel");
  });

  it("an unrecognised result is UNAVAILABLE -- the plugin's own 'No' is not Don't Save", async () => {
    const unknown: unknown[] = ["No", "Yes", "Ok", "", "don't save", undefined, null, false, 0];
    for (const result of unknown) {
      tauriMessage.mockResolvedValueOnce(result);
      expect(await askSaveDiscardCancelAsync("q", labels), String(result)).toBe("unavailable");
    }
  });

  it("a dialog that rejects or throws is UNAVAILABLE, never discard", async () => {
    tauriMessage.mockRejectedValueOnce(new Error("a modal is already open"));
    expect(await askSaveDiscardCancelAsync("q", labels)).toBe("unavailable");
    tauriMessage.mockImplementationOnce(() => {
      throw new Error("ipc down");
    });
    expect(await askSaveDiscardCancelAsync("q", labels)).toBe("unavailable");
  });

  it("with no Tauri bridge it is UNAVAILABLE and asks nothing -- not even the platform confirm", async () => {
    delete w.__TAURI_INTERNALS__;
    const platformConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await askSaveDiscardCancelAsync("q", labels)).toBe("unavailable");
    expect(tauriMessage).not.toHaveBeenCalled();
    expect(platformConfirm).not.toHaveBeenCalled();
  });

  it("labels that cannot be told apart, or a discard spelled like a dismissal, are UNAVAILABLE without asking", async () => {
    tauriMessage.mockResolvedValue("Save");
    const refused = [
      { ...labels, discardLabel: "Save" },
      { ...labels, discardLabel: "Cancel" },
      { saveLabel: "Close", discardLabel: "Don't Save", cancelLabel: "Close" },
      { saveLabel: "Save", discardLabel: "Cancel", cancelLabel: "Keep Editing" },
      { saveLabel: "Cancel", discardLabel: "Don't Save", cancelLabel: "Keep Editing" },
    ];
    for (const options of refused) {
      expect(await askSaveDiscardCancelAsync("q", options), JSON.stringify(options)).toBe("unavailable");
    }
    expect(tauriMessage).not.toHaveBeenCalled();
  });

  it("defaults to Save / Don't Save / Cancel", async () => {
    tauriMessage.mockResolvedValue("Don't Save");
    expect(await askSaveDiscardCancelAsync("q")).toBe("discard");
    expect(tauriMessage.mock.calls[0][1]).toMatchObject({
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
  });
});

describe("alertAsync", () => {
  it("shows the message through the platform alert and resolves", async () => {
    const spy = vi.spyOn(window, "alert").mockImplementation(() => {});
    await expect(alertAsync("something failed")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("something failed");
  });

  // A message box that cannot be shown must not become an unhandled rejection
  // inside the caller's catch block.
  it("never rejects when the platform alert throws", async () => {
    vi.spyOn(window, "alert").mockImplementation(() => {
      throw new Error("headless");
    });
    await expect(alertAsync("boom")).resolves.toBeUndefined();
  });
});

describe("promptAsync", () => {
  const overlay = () => document.querySelector(`[${PROMPT_DIALOG_ATTR}]`);
  const input = () => overlay()?.querySelector("input") as HTMLInputElement;
  const button = (label: string) =>
    [...(overlay()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement;

  it("resolves the typed value on OK and removes the modal", async () => {
    const pending = promptAsync("Name?", { defaultValue: "seed" });
    expect(input().value).toBe("seed");
    input().value = "Sheet7";
    button("OK").click();
    expect(await pending).toBe("Sheet7");
    expect(overlay()).toBeNull();
  });

  // THE REFUSAL PATH. window.prompt is the one global Tauri does not replace at
  // all, so a suppressed prompt returned null indistinguishably from a cancel.
  it("resolves NULL on Cancel", async () => {
    const pending = promptAsync("Name?", { defaultValue: "seed" });
    button("Cancel").click();
    expect(await pending).toBeNull();
    expect(overlay()).toBeNull();
  });

  it("resolves NULL on Escape", async () => {
    const pending = promptAsync("Name?");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await pending).toBeNull();
  });

  it("commits on Enter while the field has focus", async () => {
    const pending = promptAsync("Name?", { defaultValue: "abc" });
    input().focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(await pending).toBe("abc");
  });

  it("renders a password field when asked, so credentials are not shoulder-surfed", async () => {
    const pending = promptAsync("Password?", { password: true });
    expect(input().type).toBe("password");
    button("Cancel").click();
    await pending;
  });

  it("settles once — a second click cannot re-resolve or double-remove", async () => {
    const pending = promptAsync("Name?", { defaultValue: "x" });
    const ok = button("OK");
    ok.click();
    ok.click();
    expect(await pending).toBe("x");
    expect(overlay()).toBeNull();
  });
});
