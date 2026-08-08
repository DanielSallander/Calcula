//! FILENAME: app/src/api/__tests__/consentGatesFailClosed.test.ts
// PURPOSE: Prove that pressing CANCEL on each consent gate now REFUSES.
// CONTEXT: All of these gates were built on `window.confirm`. Under Tauri that
//          global returns a Promise, so `if (!window.confirm(m)) return false;`
//          tested `!Promise` — always false — and the gate never fired. The
//          failure mode was not "the dialog is ugly": it was that pressing
//          Cancel GRANTED consent.
//
// WHY THESE TESTS DID NOT EXIST BEFORE, and why they are shaped this way:
//   scriptSecurity.test.ts already had a "user declines -> denies" case. It
//   passed throughout, because it mocked `window.confirm` with
//   `mockReturnValueOnce(false)` — the SYNCHRONOUS jsdom shape. `!false` is
//   true, so the broken guard looked correct under test while being dead in the
//   product. Every test here therefore mocks the TAURI shape:
//
//       vi.spyOn(window, "confirm").mockReturnValue(Promise.resolve(false))
//
//   Against the pre-fix code each of these fails; that is the point of them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeMock(...args),
  createVirtualFile: vi.fn(),
  readVirtualFile: vi.fn(async () => {
    throw new Error("no such virtual file");
  }),
}));

vi.mock("../../core/lib/file-api", () => ({
  getCurrentFilePath: async () => null,
}));

vi.mock("../codeInventory", () => ({
  getWorkbookCodeUnits: async () => [],
}));

import { ensureScriptsAllowed } from "../scriptSecurity";
import {
  requestCapabilityGrant,
  resolveCapabilityRequest,
  noteLapsedGrant,
  resetLapsedGrantNotices,
  resetAllGrants,
  wasDeniedThisSession,
} from "../scriptHost/capabilities";

/** The Tauri shape: an async global that RESOLVES the user's answer. */
function tauriConfirm(answer: boolean) {
  return vi
    .spyOn(window, "confirm")
    .mockReturnValue(Promise.resolve(answer) as unknown as boolean);
}

beforeEach(() => {
  invokeMock.mockReset();
  resetLapsedGrantNotices();
  resetAllGrants();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// GATE 1 + 2 — scriptSecurity.ensureScriptsAllowed
// Authorises: grantScriptSessionApproval() (every user script in the workbook
// may run for the session) and, on the second prompt, trustCurrentWorkbook()
// (a PERSISTENT, machine-local trust record).
// ===========================================================================
describe("ensureScriptsAllowed — the run gate", () => {
  it("CANCEL refuses and never grants the session approval", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval"); // getScriptExecutionStatus
    tauriConfirm(false);

    expect(await ensureScriptsAllowed("Run this workbook's scripts?")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_session_approval");
  });

  it("OK still allows and grants, so the fix did not break the happy path", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval");
    invokeMock.mockResolvedValueOnce(undefined); // grant
    tauriConfirm(true);

    expect(await ensureScriptsAllowed("Run this workbook's scripts?")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("grant_script_session_approval");
  });

  // FAIL CLOSED: a dialog that cannot be shown is not consent.
  it("a confirm that REJECTS refuses rather than granting", async () => {
    invokeMock.mockResolvedValueOnce("needsApproval");
    vi.spyOn(window, "confirm").mockReturnValue(
      Promise.reject(new Error("no dialog")) as unknown as boolean,
    );

    expect(await ensureScriptsAllowed("Run this workbook's scripts?")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_session_approval");
  });
});

// ===========================================================================
// GATE 3 — capabilities.requestCapabilityGrant, lapsed-grant notice
// Authorises: proceeding to the JIT permission dialog after a script whose
// persisted "Allow always" grant LAPSED (its source changed) asks again. The
// module's own doc says "declining the notice is a deny" — it did not deny.
// ===========================================================================
describe("requestCapabilityGrant — the lapsed-grant re-consent notice", () => {
  const ARGS = {
    scriptId: "btn-1",
    scriptName: "Refresh Button",
    capability: "net.fetch" as const,
    origin: "https://api.example.com",
  };

  it("CANCEL on the notice denies, and never raises the permission dialog", async () => {
    noteLapsedGrant(ARGS.scriptId, "The script changed since you allowed net.fetch.");
    tauriConfirm(false);

    const dialogListener = vi.fn();
    window.addEventListener("scriptable-objects:capability-request", dialogListener);

    await expect(requestCapabilityGrant(ARGS)).resolves.toBe("deny");
    expect(dialogListener).not.toHaveBeenCalled();

    window.removeEventListener("scriptable-objects:capability-request", dialogListener);
  });

  it("the denial is remembered for the session, so it is not re-asked", async () => {
    noteLapsedGrant(ARGS.scriptId, "changed");
    tauriConfirm(false);

    await requestCapabilityGrant(ARGS);
    expect(wasDeniedThisSession(ARGS.scriptId, ARGS.capability, ARGS.origin)).toBe(true);
  });

  it("OK on the notice continues to the permission dialog", async () => {
    noteLapsedGrant(ARGS.scriptId, "changed");
    tauriConfirm(true);

    // The dialog is rendered by the ScriptableObjects extension, which answers
    // via resolveCapabilityRequest. Stand in for it here.
    const listener = (e: Event) => {
      const { requestId } = (e as CustomEvent<{ requestId: string }>).detail;
      resolveCapabilityRequest(requestId, "allowOnce");
    };
    window.addEventListener("scriptable-objects:capability-request", listener);
    try {
      await expect(requestCapabilityGrant(ARGS)).resolves.toBe("allowOnce");
    } finally {
      window.removeEventListener("scriptable-objects:capability-request", listener);
    }
  });

  // FAIL CLOSED: the old code probed `typeof window.confirm === "function"` and
  // SKIPPED the notice entirely when no dialog surface existed.
  it("a confirm that REJECTS denies rather than skipping the notice", async () => {
    noteLapsedGrant(ARGS.scriptId, "changed");
    vi.spyOn(window, "confirm").mockReturnValue(
      Promise.reject(new Error("no dialog")) as unknown as boolean,
    );

    await expect(requestCapabilityGrant(ARGS)).resolves.toBe("deny");
  });
});
