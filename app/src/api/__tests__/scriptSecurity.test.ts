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

  it("on 'needsApproval' + user confirms: grants session approval and allows", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval"); // status query
    invokeMock.mockResolvedValueOnce(undefined); // grant
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    expect(await ensureScriptsAllowed("msg")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("grant_script_session_approval");
  });

  it("on 'needsApproval' + user declines: denies and does NOT grant", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval");
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    expect(await ensureScriptsAllowed("msg")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_session_approval");
  });
});
