//! FILENAME: app/extensions/ScriptableObjects/__tests__/followReboundScripts.test.ts
// PURPOSE: rev4B#2 -- a script the BACKEND re-bound (a named-range script
//          following its name through a rename, its undo or its redo, by any
//          route) is followed by the main window: its registry entry and its
//          live mount move to the stored binding; and the open editor merges
//          the binding alone, never its buffer.
// CONTEXT: Nothing announced such a move before, so the main window kept the
//          old binding: Edit Script on the renamed name scaffolded a SECOND
//          script (the registry looks scripts up by binding), the mount kept
//          answering under the old name, and the registry pushed the old
//          binding to the editor window, whose next save wrote it back.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  stored: new Map<string, { instanceId: string | null }>(),
  listeners: [] as Array<(detail: { id: string; change: string }) => void>,
  rebind: vi.fn((_id: string, _instanceId: string | null) => false),
}));

vi.mock("@api", async () => ({
  ObjectScriptManager: (await vi.importActual<typeof import("@api/scriptableObjects")>("@api/scriptableObjects"))
    .ObjectScriptManager,
  getObjectScript: vi.fn(async (id: string) => {
    const stored = hoisted.stored.get(id);
    if (!stored) throw new Error(`Object script '${id}' not found`);
    return { id, instanceId: stored.instanceId };
  }),
  onObjectScriptsChanged: vi.fn(async (cb: (detail: { id: string; change: string }) => void) => {
    hoisted.listeners.push(cb);
    return () => undefined;
  }),
}));
vi.mock("@api/scriptHost/host", () => ({
  hostRebindMountedScript: hoisted.rebind,
}));

import { getObjectScript } from "@api";
import { ObjectScriptManager, type ObjectScriptDefinition } from "@api/scriptableObjects";
import {
  followReboundScript,
  installReboundScriptFollower,
  withStoredBinding,
} from "../lib/followReboundScripts";
import { mergeReboundBinding } from "../lib/reboundBinding";

function script(id: string, instanceId: string | null, source = "// code"): ObjectScriptDefinition {
  return { id, name: id, objectType: "namedRange", instanceId, source, accessLevel: "restricted" };
}

/** Let the announcement's async read settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("the main window follows a script the backend re-bound", () => {
  beforeEach(() => {
    hoisted.stored.clear();
    hoisted.listeners.length = 0;
    hoisted.rebind.mockReset().mockReturnValue(false);
    for (const s of ObjectScriptManager.getAllScripts()) ObjectScriptManager.removeScript(s.id);
  });

  // SABOTAGE: make `followReboundScript` skip the registry update -- the
  // getScript("namedRange", "Tax") assertion fails (null).
  it("a 'rebound' announcement moves the registry entry and re-keys the live mount", async () => {
    ObjectScriptManager.registerScript(script("s-rate", "Rate"));
    ObjectScriptManager.registerScript(script("s-other", "Other"));
    installReboundScriptFollower();
    await settle();
    expect(hoisted.listeners).toHaveLength(1);

    // The Name Manager renamed Rate to Tax; the backend re-pointed the script.
    hoisted.stored.set("s-rate", { instanceId: "Tax" });
    hoisted.listeners[0]({ id: "s-rate", change: "rebound" });
    await settle();

    expect(
      ObjectScriptManager.getScript("namedRange", "Tax")?.id,
      "Edit Script on the renamed name finds the SAME script, not a scaffold",
    ).toBe("s-rate");
    expect(ObjectScriptManager.getScript("namedRange", "Rate")).toBeNull();
    expect(ObjectScriptManager.getScript("namedRange", "Other")?.id, "another script stays").toBe("s-other");
    expect(hoisted.rebind).toHaveBeenCalledWith("s-rate", "Tax");
  });

  // rev6B#6. The backend moves a script's scheduled jobs in the same step as
  // its binding, so until this window re-keys the mount, a due job is called
  // at an address nothing answers: a failed run, and a one-shot job is gone.
  // The follower used to read the binding back first (a round trip inside
  // that window); a "rebound" now names its binding and is applied in the
  // event handler itself.
  // SABOTAGE: make `followReboundAnnouncement` ignore `detail.instanceId`
  // (always read back) -- the synchronous assertions fail.
  it("a 'rebound' naming its binding re-keys in the handler itself, with no read in between", () => {
    ObjectScriptManager.registerScript({ ...script("s-btn", "control-0-5-2"), objectType: "shape" });
    installReboundScriptFollower();
    return settle().then(() => {
      hoisted.stored.set("s-btn", { instanceId: "control-0-6-2" });
      const reads = vi.mocked(getObjectScript).mock.calls.length;

      hoisted.listeners[0]({ id: "s-btn", change: "rebound", instanceId: "control-0-6-2" } as never);

      // No await: the move happened inside the handler.
      expect(hoisted.rebind, "the live mount is re-keyed at once").toHaveBeenCalledWith("s-btn", "control-0-6-2");
      expect(ObjectScriptManager.getScript("shape", "control-0-6-2")?.id).toBe("s-btn");
      expect(vi.mocked(getObjectScript).mock.calls.length, "nothing was read back").toBe(reads);

      // A control deleted with its row unbinds the script: null is a binding too.
      hoisted.listeners[0]({ id: "s-btn", change: "rebound", instanceId: null } as never);
      expect(hoisted.rebind).toHaveBeenLastCalledWith("s-btn", null);
      expect(ObjectScriptManager.getAllScripts().find((s) => s.id === "s-btn")?.instanceId).toBeNull();
    });
  });

  it("only a 'rebound' change moves anything; a save or a delete is someone else's", async () => {
    ObjectScriptManager.registerScript(script("s-rate", "Rate"));
    installReboundScriptFollower();
    await settle();
    hoisted.stored.set("s-rate", { instanceId: "Tax" });
    hoisted.listeners[0]({ id: "s-rate", change: "saved" });
    hoisted.listeners[0]({ id: "s-rate", change: "deleted" });
    await settle();
    expect(ObjectScriptManager.getScript("namedRange", "Rate")?.id).toBe("s-rate");
    expect(hoisted.rebind).not.toHaveBeenCalled();
  });

  it("a script the store no longer has is left alone (a removal is not a move)", async () => {
    ObjectScriptManager.registerScript(script("s-gone", "Rate"));
    expect(await followReboundScript("s-gone")).toBe(false);
    expect(ObjectScriptManager.getScript("namedRange", "Rate")?.id).toBe("s-gone");
    expect(hoisted.rebind).not.toHaveBeenCalled();
  });

  // SABOTAGE: return `script` unchanged from `withStoredBinding` -- the
  // instanceId assertion fails ("Rate").
  it("a save-and-apply registers and mounts the STORED binding, not the editor's stale copy", async () => {
    hoisted.stored.set("s-rate", { instanceId: "Tax" });
    const applied = await withStoredBinding(script("s-rate", "Rate", "// edited"));
    expect(applied.instanceId).toBe("Tax");
    expect(applied.source, "everything else is the editor's").toBe("// edited");
    // No stored record (a brand-new script being applied): the copy as sent.
    expect((await withStoredBinding(script("s-new", "Fresh"))).instanceId).toBe("Fresh");
  });
});

describe("the editor merges a re-bound binding and nothing else", () => {
  // SABOTAGE: return `scripts` unchanged from `mergeReboundBinding` -- the
  // first assertion fails ("Rate").
  it("moves only the named script's binding, keeps every other field and entry", () => {
    const before = [script("s-rate", "Rate", "// buffer the author saw"), script("s-other", "Other")];
    const after = mergeReboundBinding(before, "s-rate", "Tax");
    expect(after[0].instanceId).toBe("Tax");
    expect(after[0].source).toBe("// buffer the author saw");
    expect(after[1]).toBe(before[1]);
    expect(after).toHaveLength(2);
    expect(before[0].instanceId, "the input list is not mutated").toBe("Rate");
  });

  it("returns the SAME list when nothing moves (no re-render) or the script is not listed", () => {
    const list = [script("s-rate", "Tax")];
    expect(mergeReboundBinding(list, "s-rate", "Tax")).toBe(list);
    expect(mergeReboundBinding(list, "s-missing", "Tax")).toBe(list);
  });
});
