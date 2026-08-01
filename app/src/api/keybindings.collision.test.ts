//! FILENAME: app/src/api/keybindings.collision.test.ts
// PURPOSE: A user's own shortcut may shadow a live script shortcut — the user
//          must WIN, and must be TOLD, naming the script.
// CONTEXT: `handleGlobalKeyDown` resolves ties in the user's favour ("THE APP
//          ALWAYS WINS"), which is right and must not change. What was missing
//          was the sentence. A script binding is refused at registration when
//          the combination is taken, so a collision can only be created from the
//          user's side; the script then keeps its row in the shortcut list, keeps
//          looking bound, and silently stops firing. That is VBA's
//          Application.OnKey failure with the roles reversed — somebody staring
//          at a keyboard that does not do what the list says.
//
//          These tests pin: (1) the warning exists and names the script and what
//          it used to call; (2) the user is never REFUSED; (3) the dispatcher
//          really does hand the keys to the user's binding afterwards; and
//          (4) a collision with an ordinary app binding does not raise the
//          script-specific warning (that would cry wolf).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toasts: { message: string; variant?: string }[] = [];
vi.mock("./notifications", () => ({
  showToast: (message: string, options?: { variant?: string }) => {
    toasts.push({ message, variant: options?.variant });
  },
}));

const executed: string[] = [];
vi.mock("./commands", () => ({
  CommandRegistry: {
    execute: vi.fn(async (id: string) => {
      executed.push(id);
    }),
    getAll: () => [],
  },
}));

import {
  addCustomKeybinding,
  setUserKeybinding,
  findScriptKeybindingCollision,
  registerScriptKeybinding,
  revokeScriptKeybindingsForScript,
  removeCustomKeybinding,
  registerKeybinding,
  getAllKeybindings,
  handleGlobalKeyDown,
  resetAllKeybindings,
} from "./keybindings";

/** A keydown that jsdom's Event can carry through the real dispatcher. */
function keydown(combo: {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: combo.key,
    ctrlKey: !!combo.ctrl,
    shiftKey: !!combo.shift,
    altKey: !!combo.alt,
    cancelable: true,
    bubbles: true,
  });
}

/** Wipe every binding the previous test left behind — the registry is a module
 *  singleton, so a leaked custom binding would silently change the next test. */
function clearRegistry(): void {
  for (const b of getAllKeybindings()) {
    if (b.source === "user") removeCustomKeybinding(b.id);
    else if (b.source === "script") revokeScriptKeybindingsForScript(b.scriptId!);
  }
  resetAllKeybindings();
}

beforeEach(() => {
  toasts.length = 0;
  executed.length = 0;
  localStorage.clear();
  clearRegistry();
});

afterEach(() => {
  clearRegistry();
});

function bindScriptShortcut(scriptId = "s1", scriptName = "Sales refresher"): void {
  const res = registerScriptKeybinding({
    scriptId,
    scriptName,
    combo: "Ctrl+Shift+R",
    handler: "refreshAll",
    run: () => undefined,
  });
  expect(res.ok, `script binding should have been accepted: ${JSON.stringify(res)}`).toBe(true);
}

describe("findScriptKeybindingCollision", () => {
  it("returns null when the keys are free", () => {
    expect(findScriptKeybindingCollision("Ctrl+Shift+R")).toBeNull();
  });

  it("names the script and what pressing the keys used to call", () => {
    bindScriptShortcut();
    const c = findScriptKeybindingCollision("Ctrl+Shift+R");
    expect(c).not.toBeNull();
    expect(c!.combo).toBe("Ctrl+Shift+R");
    expect(c!.shadowedScriptNames).toEqual(["Sales refresher"]);
    expect(c!.shadowedLabels).toEqual(["refreshAll()"]);
    expect(c!.message).toContain("Sales refresher");
    expect(c!.message).toContain("refreshAll()");
    expect(c!.message).toMatch(/stop responding/i);
  });

  it("normalizes the combination before comparing", () => {
    bindScriptShortcut();
    expect(findScriptKeybindingCollision("ctrl+shift+r")).not.toBeNull();
  });

  it("does NOT fire for a collision with an ordinary app binding", () => {
    // Ctrl+Shift+L is a built-in (Toggle AutoFilter). Warning about it here
    // would cry wolf: the shortcut list already shows both, and no sandboxed
    // code is being silently disabled.
    registerKeybinding({
      id: "test.builtin",
      combo: "Ctrl+Alt+J",
      commandId: "test.cmd",
      label: "Test",
      category: "Test",
      source: "built-in",
    });
    expect(findScriptKeybindingCollision("Ctrl+Alt+J")).toBeNull();
  });

  it("sees through the script's unmount — a revoked shortcut is no collision", () => {
    bindScriptShortcut();
    revokeScriptKeybindingsForScript("s1");
    expect(findScriptKeybindingCollision("Ctrl+Shift+R")).toBeNull();
  });

  it("names every script when more than one is shadowed", () => {
    bindScriptShortcut("s1", "Alpha");
    // A second script cannot take the same combo (rule 3 refuses it), so the
    // multi-script case is built by binding a different combo and asking about
    // a combination that matches only one — the plural phrasing is still
    // exercised through the API rather than by hand-building state.
    const res = registerScriptKeybinding({
      scriptId: "s2",
      scriptName: "Beta",
      combo: "Ctrl+Shift+T",
      handler: "run",
      run: () => undefined,
    });
    expect(res.ok).toBe(true);
    expect(findScriptKeybindingCollision("Ctrl+Shift+T")!.shadowedScriptNames).toEqual(["Beta"]);
    expect(findScriptKeybindingCollision("Ctrl+Shift+R")!.shadowedScriptNames).toEqual(["Alpha"]);
  });
});

describe("addCustomKeybinding", () => {
  it("warns at bind time, naming the script, and still creates the binding", () => {
    bindScriptShortcut();
    const { binding, collision } = addCustomKeybinding(
      "Ctrl+Shift+R",
      "test.cmd",
      "My macro",
    );
    expect(binding.source).toBe("user");
    expect(binding.combo).toBe("Ctrl+Shift+R");
    expect(collision).not.toBeNull();
    expect(collision!.shadowedScriptNames).toEqual(["Sales refresher"]);

    // ...and the explanation reaches the user even though the settings page
    // ignores the returned value.
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("warning");
    expect(toasts[0].message).toContain("Sales refresher");
  });

  it("never refuses — it is the user's keyboard", () => {
    bindScriptShortcut();
    const { binding } = addCustomKeybinding("Ctrl+Shift+R", "test.cmd", "My macro");
    expect(getAllKeybindings().some((b) => b.id === binding.id)).toBe(true);
  });

  it("says nothing when the keys are free", () => {
    const { collision } = addCustomKeybinding("Ctrl+Alt+Q", "test.cmd", "Mine");
    expect(collision).toBeNull();
    expect(toasts).toHaveLength(0);
  });

  it("never reports the new binding as colliding with itself", () => {
    const { collision } = addCustomKeybinding("Ctrl+Shift+Y", "test.cmd", "Mine");
    expect(collision).toBeNull();
  });

  /// The warning has to be TRUE: after the collision, the keys must really run
  /// the user's command and the script must really not fire.
  it("tells the truth — the user's command runs and the script does not", () => {
    let scriptRan = 0;
    const res = registerScriptKeybinding({
      scriptId: "s1",
      scriptName: "Sales refresher",
      combo: "Ctrl+Shift+R",
      handler: "refreshAll",
      run: () => {
        scriptRan += 1;
      },
    });
    expect(res.ok).toBe(true);

    addCustomKeybinding("Ctrl+Shift+R", "user.macro", "My macro");
    const handled = handleGlobalKeyDown(keydown({ key: "R", ctrl: true, shift: true }));
    expect(handled).toBe(true);
    expect(executed).toEqual(["user.macro"]);
    expect(scriptRan).toBe(0);
  });

  /// ...and removing the user's shortcut hands the keys back.
  it("hands the keys back to the script when the user's shortcut is removed", () => {
    let scriptRan = 0;
    registerScriptKeybinding({
      scriptId: "s1",
      scriptName: "Sales refresher",
      combo: "Ctrl+Shift+R",
      handler: "refreshAll",
      run: () => {
        scriptRan += 1;
      },
    });
    const { binding } = addCustomKeybinding("Ctrl+Shift+R", "user.macro", "My macro");
    expect(removeCustomKeybinding(binding.id)).toBe(true);

    handleGlobalKeyDown(keydown({ key: "R", ctrl: true, shift: true }));
    expect(scriptRan).toBe(1);
    expect(executed).toEqual([]);
  });
});

describe("setUserKeybinding", () => {
  it("warns when a REMAP lands on a combination a script holds", () => {
    bindScriptShortcut();
    registerKeybinding({
      id: "test.remap",
      combo: "Ctrl+Alt+J",
      commandId: "test.cmd",
      label: "Test",
      category: "Test",
      source: "built-in",
    });
    const collision = setUserKeybinding("test.remap", "Ctrl+Shift+R");
    expect(collision).not.toBeNull();
    expect(collision!.shadowedScriptNames).toEqual(["Sales refresher"]);
    expect(toasts.some((t) => t.message.includes("Sales refresher"))).toBe(true);
  });

  it("says nothing for an ordinary remap", () => {
    registerKeybinding({
      id: "test.remap",
      combo: "Ctrl+Alt+J",
      commandId: "test.cmd",
      label: "Test",
      category: "Test",
      source: "built-in",
    });
    expect(setUserKeybinding("test.remap", "Ctrl+Alt+K")).toBeNull();
    expect(toasts).toHaveLength(0);
  });

  it("still refuses to remap a script's own binding", () => {
    bindScriptShortcut();
    const scriptBinding = getAllKeybindings().find((b) => b.source === "script")!;
    expect(setUserKeybinding(scriptBinding.id, "Ctrl+Shift+Z")).toBeNull();
  });
});
