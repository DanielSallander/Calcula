import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeMock(...args),
}));

import { ensureScriptsAllowed } from "../scriptSecurity";

describe("scriptSecurity gate (B1)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("allows without prompting when status is 'allowed'", async () => {
    invokeMock.mockResolvedValueOnce("allowed");
    const confirm = vi.spyOn(window, "confirm");
    expect(await ensureScriptsAllowed("msg")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("denies without prompting when status is 'disabled'", async () => {
    invokeMock.mockResolvedValueOnce("disabled");
    const confirm = vi.spyOn(window, "confirm");
    expect(await ensureScriptsAllowed("msg")).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  // THE DOUBLE MUST BE ASYNC. These two cases originally mocked confirm with a
  // plain boolean — the SYNCHRONOUS jsdom shape. That made the decline case pass
  // while the product was broken: under Tauri window.confirm returns a Promise,
  // so the gate's `if (!window.confirm(m))` tested `!Promise` (always false) and
  // Cancel granted the approval. A sync double could never have caught it.
  // Promise-returning doubles reproduce the real runtime; the fail-closed and
  // rejection cases live in ./consentGatesFailClosed.test.ts.
  const tauriConfirm = (answer: boolean) =>
    vi.spyOn(window, "confirm").mockReturnValue(Promise.resolve(answer) as unknown as boolean);

  it("on 'needsApproval' + user confirms: grants session approval and allows", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval"); // status query
    invokeMock.mockResolvedValueOnce(undefined); // grant
    tauriConfirm(true);
    expect(await ensureScriptsAllowed("msg")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("grant_script_session_approval");
  });

  it("on 'needsApproval' + user declines: denies and does NOT grant", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval");
    tauriConfirm(false);
    expect(await ensureScriptsAllowed("msg")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_session_approval");
  });
});
