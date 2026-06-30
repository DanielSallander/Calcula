//! FILENAME: app/src/api/__tests__/mountGate.test.ts
// PURPOSE: The universal Script-Security gate at the worker-realm mount chokepoint.
//   assertMountAllowed (scriptHost/mountGate) is what hostMountScript calls before
//   spawning ANY worker — object scripts, custom chart marks, custom chart
//   transforms, JS UDF libraries — so "disabled" (or a declined "prompt") blocks
//   every surface. host.ts itself is too heavy (worker/render/broker graph) to
//   import in jsdom, so the gate decision is extracted into mountGate.ts and tested
//   directly here. The three-state decision logic of ensureScriptsAllowed itself is
//   covered by scriptSecurity.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureScriptsAllowed = vi.fn();
// mountGate imports "../scriptSecurity"; from this test file that resolves to the
// same module, so this mock intercepts the gate's only dependency.
vi.mock("../scriptSecurity", () => ({
  ensureScriptsAllowed: (...args: unknown[]) => ensureScriptsAllowed(...args),
}));

import { assertMountAllowed, ScriptSecurityBlockedError } from "../scriptHost/mountGate";

describe("assertMountAllowed — universal worker-realm mount gate", () => {
  beforeEach(() => ensureScriptsAllowed.mockReset());

  it("resolves when the Script Security gate allows", async () => {
    ensureScriptsAllowed.mockResolvedValueOnce(true);
    await expect(assertMountAllowed("My UDFs")).resolves.toBeUndefined();
    expect(ensureScriptsAllowed).toHaveBeenCalledTimes(1);
  });

  it("throws ScriptSecurityBlockedError when the gate denies — so no worker is spawned", async () => {
    ensureScriptsAllowed.mockResolvedValueOnce(false);
    await expect(assertMountAllowed("Evil mark")).rejects.toBeInstanceOf(
      ScriptSecurityBlockedError,
    );
  });

  it("names the blocked script in the error message", async () => {
    ensureScriptsAllowed.mockResolvedValueOnce(false);
    await expect(assertMountAllowed("Sneaky")).rejects.toThrow(/Sneaky/);
  });
});
