//! FILENAME: app/src/core/lib/__tests__/dialogs.test.ts
// PURPOSE: Lock the contract of the dialog wrappers that replaced the raw
//          window.confirm / window.alert / window.prompt globals.
// CONTEXT: The defect these retire shipped SIX times. Every test below is
//          written against the TAURI shape of the global — a Promise-returning
//          confirm — because that is the shape no previous test used, and the
//          reason the bug kept passing review: jsdom's confirm is synchronous,
//          so a `mockReturnValue(false)` double made the broken
//          `if (!window.confirm(m))` guard look like it worked.

import { describe, it, expect, vi, afterEach } from "vitest";
import { confirmAsync, alertAsync, promptAsync, PROMPT_DIALOG_ATTR } from "../dialogs";

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
