//! FILENAME: app/src/api/__tests__/objectScriptMountGate.test.ts
// PURPOSE: B1 — every object-script mount path consults the global "Script
//   Security" setting. `ObjectScriptManager.mountScript` is the single chokepoint
//   all mount paths funnel through (workbook open, cross-window save-and-apply,
//   the manual toggle in the Object Scripts pane, code-editor remount, and
//   component/shape template stamping). These tests assert the gate is consulted
//   on EVERY mount and that a denial blocks the worker mount entirely.
// NOTE: jsdom has no Worker, so the real mount cannot run; we mock the host so
//   the test isolates the gate decision, not the worker realm.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureScriptsAllowed = vi.fn();
vi.mock("../scriptSecurity", () => ({
  ensureScriptsAllowed: (...args: unknown[]) => ensureScriptsAllowed(...args),
}));

const hostMountScript = vi.fn().mockResolvedValue(undefined);
const hostUnmountScript = vi.fn();
const hostResetAll = vi.fn();
vi.mock("../scriptHost/host", () => ({
  hostMountScript: (...args: unknown[]) => hostMountScript(...args),
  hostUnmountScript: (...args: unknown[]) => hostUnmountScript(...args),
  hostResetAll: (...args: unknown[]) => hostResetAll(...args),
}));

import { ObjectScriptManager, resetObjectScriptManager } from "../scriptableObjects";
import type { ObjectScriptDefinition } from "../scriptableObjects";

function makeScript(): ObjectScriptDefinition {
  return {
    id: crypto.randomUUID(),
    name: "gate test script",
    objectType: "workbook",
    instanceId: null,
    source: "function setup(ctx) {}",
    accessLevel: "restricted",
  };
}

describe("ObjectScriptManager.mountScript — Script Security gate (B1)", () => {
  beforeEach(() => {
    resetObjectScriptManager();
    ensureScriptsAllowed.mockReset();
    hostMountScript.mockReset().mockResolvedValue(undefined);
    hostUnmountScript.mockReset();
  });

  it("does NOT mount when the Script Security gate denies — and THROWS so", async () => {
    ensureScriptsAllowed.mockResolvedValueOnce(false);
    const script = makeScript();
    ObjectScriptManager.registerScript(script);

    // The refusal must reach the caller. It used to `return` quietly, which is
    // how a button-creation flow came to report "it will run after a reload"
    // for a script the user had just declined — the same reload would decline
    // it again.
    await expect(ObjectScriptManager.mountScript(script.id)).rejects.toThrow(
      /Script Security/i,
    );

    expect(ensureScriptsAllowed).toHaveBeenCalledTimes(1);
    expect(hostMountScript).not.toHaveBeenCalled();
    expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(false);
  });

  it("THROWS when the worker mount itself fails", async () => {
    ensureScriptsAllowed.mockResolvedValueOnce(true);
    hostMountScript.mockRejectedValueOnce(new Error("setup() blew up"));
    const script = makeScript();
    ObjectScriptManager.registerScript(script);

    await expect(ObjectScriptManager.mountScript(script.id)).rejects.toThrow(
      /setup\(\) blew up/,
    );
    expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(false);
  });

  it("THROWS for an id nothing is registered under", async () => {
    await expect(ObjectScriptManager.mountScript("no-such-script")).rejects.toThrow(
      /no-such-script/,
    );
  });

  it("mounts when the gate allows", async () => {
    ensureScriptsAllowed.mockResolvedValueOnce(true);
    const script = makeScript();
    ObjectScriptManager.registerScript(script);

    await ObjectScriptManager.mountScript(script.id);

    expect(hostMountScript).toHaveBeenCalledTimes(1);
    expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(true);
  });

  it("consults the gate on EVERY mount call (no manager-side caching)", async () => {
    ensureScriptsAllowed.mockResolvedValue(true);
    const script = makeScript();
    ObjectScriptManager.registerScript(script);

    await ObjectScriptManager.mountScript(script.id);
    await ObjectScriptManager.mountScript(script.id);

    expect(ensureScriptsAllowed).toHaveBeenCalledTimes(2);
  });
});
