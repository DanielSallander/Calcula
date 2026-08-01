//! FILENAME: app/src/api/scriptHost/__tests__/scriptKeyboardShortcuts.test.ts
// PURPOSE: Guard G2 — the `ui.shortcut` capability, Calcula's replacement for
//          VBA's Application.OnKey — against the five ways a keyboard hook
//          becomes the thing it replaced:
//            1. it captures a key the app or the grid needs (Ctrl+S, F9,
//               Escape, Tab, an arrow, or plain typing);
//            2. it overrides a combination something else already holds,
//               silently, by registration order;
//            3. it is invisible — nothing lists it, nothing can take it back;
//            4. it outlives the code it runs (ambient state after unmount);
//            5. it sees more than the combination it was granted (a keylogger
//               wearing a shortcut's clothes).
// CONTEXT: Layered against the REAL enforcing code — the real keybinding
//          registry and its real dispatcher, the real broker for denial, the
//          real allowlist for policy, and the Rust source read from disk for
//          the pragma ceiling. Nothing here re-implements a rule to assert it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as nodeFs from "fs";
import * as nodePath from "path";

// The audit write-through is the transparency half of this feature, so the one
// seam replaced here is the backend bridge it writes to.
const invokeBackend = vi.fn(() => Promise.resolve(undefined));
vi.mock("../../backend", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, invokeBackend: (...a: unknown[]) => invokeBackend(...a) };
});

import { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET } from "../capabilityIds";
import { ALLOWLIST } from "../allowlist";
import {
  describeCapability,
  recordCapabilityGrant,
  RUST_MIRRORED_CAPABILITIES,
  resetAllGrants,
} from "../capabilities";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";
import { METHOD_DEADLINES_MS } from "../protocol";
import { vShortcutBind, vShortcutUnbind, vNone } from "../validators";
import { brokerCall, buildHandleFromDefinition } from "../broker";
import {
  SCRIPT_SURFACES,
  auditScriptSurfaceCapabilities,
  brokerGatedCapabilities,
} from "../../scriptSurfaces";
import {
  MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT,
  getAllKeybindings,
  getEffectiveCombo,
  handleGlobalKeyDown,
  listScriptKeybindings,
  registerKeybinding,
  registerScriptKeybinding,
  revokeScriptKeybinding,
  revokeScriptKeybindingCombo,
  revokeScriptKeybindingsForScript,
  scriptComboRefusal,
  setUserKeybinding,
} from "../../keybindings";
import { CommandRegistry } from "../../commands";

const CAP = "ui.shortcut";
const SHORTCUT_METHODS = ["cap.shortcutBind", "cap.shortcutUnbind", "cap.shortcutList"];

const HOST_SOURCE = nodeFs.readFileSync(nodePath.resolve(__dirname, "../host.ts"), "utf8");

/** Build a keydown the dispatcher can judge, without touching the real DOM
 *  listener (registerScriptKeybinding installs one; dispatching for real would
 *  run every assertion twice). */
function keydown(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  });
}

/** Register one script shortcut, returning the spy its press should reach. */
function bind(opts: {
  scriptId?: string;
  scriptName?: string;
  combo: string;
  handler?: string;
  label?: string;
}) {
  const run = vi.fn();
  const result = registerScriptKeybinding({
    scriptId: opts.scriptId ?? "s1",
    scriptName: opts.scriptName ?? "Quarterly close",
    combo: opts.combo,
    handler: opts.handler ?? "refreshAll",
    label: opts.label,
    run,
  });
  return { result, run };
}

afterEach(() => {
  revokeScriptKeybindingsForScript("s1");
  revokeScriptKeybindingsForScript("s2");
});

// ============================================================================
// 1. The capability is threaded through EVERY consumer
// ============================================================================
//
// "Declared, phrased, shimmed — and silently ungrantable" is this program's
// signature defect: four capability ids shipped that way. Each assertion here
// is one of the lists that has been missed before.

describe("ui.shortcut is a fully threaded capability", () => {
  it("is in the one vocabulary", () => {
    expect(ALL_CAPABILITY_IDS).toContain(CAP);
    expect(CAPABILITY_ID_SET.has(CAP as never)).toBe(true);
  });

  it("has consent text that names the reach AND denies the fear", () => {
    const desc = describeCapability(CAP as never);
    expect(desc).not.toBe(CAP);
    expect(desc.length).toBeGreaterThan(40);
    // "keyboard" without a denial reads as "keylogger". The bound has to be in
    // the same sentence as the grant, or the consent is not honest.
    expect(desc.toLowerCase()).toContain("shortcut");
    expect(desc.toLowerCase()).toContain("never sees anything you type");
  });

  it("survives the RUST pragma parser, which is the ceiling for a local script", () => {
    // KNOWN_CAPABILITY_IDS in core/persistence is authoritative for a locally
    // authored script: an id missing there is STRIPPED at save, so the script
    // silently loses a capability it correctly declared. Read the Rust source
    // rather than trusting a comment.
    const rust = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../../../../core/persistence/src/lib.rs"),
      "utf8",
    );
    const start = rust.indexOf("KNOWN_CAPABILITY_IDS");
    expect(start).toBeGreaterThan(0);
    const open = rust.indexOf("[", rust.indexOf("=", start));
    const close = rust.indexOf("];", open);
    const listed = [...rust.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual([...ALL_CAPABILITY_IDS]);
  });

  it("is NOT mirrored to the Rust capability store, and that is deliberate", () => {
    // Nothing here reaches the backend: the keydown listener, the registry and
    // the dispatch are all trusted main-thread code. Mirroring a grant to a
    // Rust store that has no gate for it would imply an enforcement that does
    // not exist — the same false impression the id itself avoids.
    expect(RUST_MIRRORED_CAPABILITIES.has(CAP as never)).toBe(false);
  });

  it("is offered by the surface taxonomy wherever the broker can gate it", () => {
    expect(brokerGatedCapabilities()).toContain(CAP);
    for (const audit of auditScriptSurfaceCapabilities()) {
      expect(audit.understated, `${audit.surfaceId} understates its reach`).toEqual([]);
    }
    expect(SCRIPT_SURFACES.find((s) => s.id === "object-script")?.capabilities).toContain(CAP);
  });

  it("is NOT offered to sandboxed extensions, which already have a declared path", () => {
    // An extension declares its shortcuts in the signed sidecar and binds them
    // to its own commands. A second, imperative door would be a second policy —
    // and the two would drift on exactly the question that matters.
    for (const m of SHORTCUT_METHODS) {
      expect(EXTENSION_BROKER_METHODS.has(m), `${m} should not be offered`).toBe(false);
    }
  });

  it("appears in every consent surface a user can read", () => {
    // The seven maps that turn a capability id into words. A missing entry
    // renders the raw id — or nothing — on the last screen before somebody
    // else's code runs.
    const root = nodePath.resolve(__dirname, "../../../../");
    for (const rel of [
      "extensions/Charts/components/ChartLibraryConsentDialog.tsx",
      "extensions/Distribution/components/inspector/ScriptsSection.tsx",
      "extensions/Distribution/components/SubscribeDialog.tsx",
      "extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx",
      "extensions/ScriptableObjects/components/ScriptConsentDialog.tsx",
      "extensions/ScriptableObjects/index.ts",
      "extensions/Settings/components/ScriptSecurityPage.tsx",
    ]) {
      const text = nodeFs.readFileSync(nodePath.join(root, rel), "utf8");
      expect(text, `${rel} has no ui.shortcut entry`).toContain('"ui.shortcut"');
    }
  });
});

// ============================================================================
// 2. Policy shape: tier, capability, class, deadline, limit
// ============================================================================

describe("the G2 allowlist rows", () => {
  it("gate every shortcut method on ui.shortcut at restricted tier", () => {
    for (const m of SHORTCUT_METHODS) {
      expect(ALLOWLIST[m], m).toBeDefined();
      expect(ALLOWLIST[m].capability, m).toBe(CAP);
      expect(ALLOWLIST[m].tier, m).toBe("restricted");
    }
    expect(ALLOWLIST["cap.shortcutBind"].class).toBe("mutate");
    expect(ALLOWLIST["cap.shortcutUnbind"].class).toBe("mutate");
    expect(ALLOWLIST["cap.shortcutList"].class).toBe("read");
    expect(ALLOWLIST["cap.shortcutList"].validate).toBe(vNone);
  });

  it("does NOT take the person-length deadline — nothing here waits on a human", () => {
    // class "ui"/"file" carry the five-minute deadline for a modal somebody is
    // reading. Binding a key returns immediately; borrowing that deadline would
    // misdescribe the call in the one table the worker can see.
    for (const m of SHORTCUT_METHODS) {
      expect(METHOD_DEADLINES_MS[m], m).toBeUndefined();
      expect(ALLOWLIST[m].class, m).not.toBe("ui");
    }
  });

  it("declares a shortcut cap that matches the one the registry enforces", () => {
    // The literal in the allowlist and the constant in keybindings.ts are two
    // copies of one number (the table is bundled by the typings generator, so it
    // cannot import the registry). This is the seam that keeps them equal.
    expect(ALLOWLIST["cap.shortcutBind"].limits?.maxShortcuts).toBe(
      MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT,
    );
  });

  it("has consent text that says what is taken and what cannot be", () => {
    const desc = ALLOWLIST["cap.shortcutBind"].desc.toLowerCase();
    expect(desc).toContain("ctrl+shift");
    expect(desc).toContain("never sees anything else you type");
  });
});

// ============================================================================
// 3. Argument validation (shape only — the POLICY lives in the registry)
// ============================================================================

describe("vShortcutBind bounds what crosses", () => {
  it("accepts a combo, a handler name and an optional label", () => {
    expect(vShortcutBind(["Ctrl+Shift+R", "refreshAll"])).toBe(true);
    expect(vShortcutBind(["Ctrl+Shift+R", "refreshAll", { label: "Refresh" }])).toBe(true);
  });

  it("rejects a missing or non-string handler — a shortcut must name a method", () => {
    expect(vShortcutBind(["Ctrl+Shift+R"])).not.toBe(true);
    expect(vShortcutBind(["Ctrl+Shift+R", ""])).not.toBe(true);
    expect(vShortcutBind(["Ctrl+Shift+R", 42])).not.toBe(true);
    // A FUNCTION cannot cross the worker boundary at all, but a caller that
    // tried must be refused rather than silently coerced to "[object Object]".
    expect(vShortcutBind(["Ctrl+Shift+R", () => {}])).not.toBe(true);
  });

  it("rejects an empty or oversized combo and unknown options", () => {
    expect(vShortcutBind(["", "refreshAll"])).not.toBe(true);
    expect(vShortcutBind(["   ", "refreshAll"])).not.toBe(true);
    expect(vShortcutBind(["C".repeat(65), "refreshAll"])).not.toBe(true);
    expect(vShortcutBind(["Ctrl+Shift+R", "refreshAll", { scope: "global" }])).not.toBe(true);
    expect(vShortcutUnbind([])).not.toBe(true);
    expect(vShortcutUnbind(["Ctrl+Shift+R"])).toBe(true);
  });
});

// ============================================================================
// 4. RESERVED: a script cannot capture a key the app or the grid needs
// ============================================================================

describe("the keys a script may never take", () => {
  // Every entry is a key Calcula, the grid, or plain typing depends on. The
  // enforcement is an ALLOWLIST (Ctrl+Shift+<letter>) precisely so that this
  // table can never be under-inclusive — a blocklist would have to be complete
  // to be safe, and one missing row is one key the user loses.
  const MUST_REFUSE = [
    // File / edit / clipboard essentials
    "Ctrl+S", "Ctrl+Shift+S", "Ctrl+O", "Ctrl+N", "Ctrl+P", "Ctrl+W", "Ctrl+Q",
    "Ctrl+Z", "Ctrl+Y", "Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+Shift+V", "Ctrl+A",
    "Ctrl+F", "Ctrl+H", "Ctrl+G", "Ctrl+K",
    // Grid-owned formatting and insertion (never in the keybinding registry, so
    // findConflicts would have said "free")
    "Ctrl+B", "Ctrl+I", "Ctrl+U", "Ctrl+1", "Ctrl+5", "Ctrl+;", "Ctrl+`",
    "Ctrl+Shift+~", "Ctrl+Shift+$", "Ctrl+Shift+!", "Ctrl+Shift+:",
    // Navigation and editing keys, with and without modifiers
    "Escape", "Tab", "Shift+Tab", "Enter", "Backspace", "Delete", "Insert",
    "Home", "End", "PageUp", "PageDown", " ", "Ctrl+Space", "Shift+Space",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Ctrl+ArrowRight", "Ctrl+Shift+End", "Alt+Shift+ArrowRight",
    // Function keys — in a spreadsheet EVERY one of them is a feature
    "F1", "F2", "F4", "F5", "F8", "F9", "F11", "F12",
    "Ctrl+F4", "Ctrl+Shift+F1", "Ctrl+Alt+Shift+F9",
    // Plain typing, and Shift+key (which is just a capital letter)
    "R", "r", "7", "Shift+R", "Shift+7",
    // AltGr on a European layout IS Ctrl+Alt: on sv-SE, Ctrl+Alt+2 types "@"
    "Ctrl+Alt+R", "Ctrl+Alt+2", "Alt+R", "Alt+;",
    // Meta/Cmd belongs to the OS
    "Meta+R", "Meta+Shift+R",
    // Calcula's own Ctrl+Shift+<letter> shortcuts, refused BY NAME so that a
    // user remapping one does not thereby offer it to a script
    "Ctrl+Shift+L", "Ctrl+Shift+C", "Ctrl+Shift+E", "Ctrl+Shift+X",
    "Ctrl+Shift+B", "Ctrl+Shift+N", "Ctrl+Shift+H",
    // ...and the Excel-parity reservations
    "Ctrl+Shift+A", "Ctrl+Shift+F", "Ctrl+Shift+O", "Ctrl+Shift+P", "Ctrl+Shift+U",
    // Not a combination at all
    "", "   ", "Ctrl", "Ctrl+Shift",
  ];

  it.each(MUST_REFUSE)("refuses %j", (combo) => {
    expect(scriptComboRefusal(combo), `${combo} was allowed`).not.toBeNull();
  });

  it("refuses a non-string with a reason instead of throwing", () => {
    for (const junk of [undefined, null, 42, {}, ["Ctrl+Shift+R"]]) {
      expect(scriptComboRefusal(junk)).toBeTypeOf("string");
    }
  });

  it("allows the Ctrl+Shift+<letter> space that is left, case-insensitively", () => {
    for (const combo of ["Ctrl+Shift+R", "ctrl+shift+r", "CTRL+SHIFT+J", "Shift+Ctrl+K"]) {
      expect(scriptComboRefusal(combo), `${combo} was refused`).toBeNull();
    }
  });

  it("refuses LOUDLY — the reason names the rule and reaches the caller", () => {
    const { result } = bind({ combo: "Ctrl+S" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid");
    expect(result.reason).toContain("Ctrl+Shift+<letter>");
    // ...and nothing was bound behind the refusal.
    expect(listScriptKeybindings("s1")).toEqual([]);
  });

  it("reports a Calcula-reserved combination as reserved, not as malformed", () => {
    const { result } = bind({ combo: "Ctrl+Shift+L" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("reserved");
    expect(result.reason).toContain("reserved by Calcula");
  });
});

// ============================================================================
// 5. CONFLICT: taken means refused, never overridden
// ============================================================================

describe("a combination in use is refused, not stolen", () => {
  it("refuses one already held by a built-in", () => {
    const release = registerKeybinding({
      id: "core.some.feature",
      combo: "Ctrl+Shift+J",
      commandId: "core.some.feature",
      label: "Some feature",
      category: "Editing",
      source: "built-in",
    });
    try {
      const { result } = bind({ combo: "Ctrl+Shift+J" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("conflict");
      expect(result.reason).toContain("Some feature");
    } finally {
      release();
    }
  });

  it("refuses one already held by ANOTHER script", () => {
    expect(bind({ scriptId: "s1", combo: "Ctrl+Shift+K" }).result.ok).toBe(true);
    const second = bind({ scriptId: "s2", scriptName: "Other", combo: "Ctrl+Shift+K" });
    expect(second.result.ok).toBe(false);
    if (second.result.ok) return;
    expect(second.result.code).toBe("conflict");
    // The first script still owns it — a refusal must never leave the winner
    // half-evicted.
    expect(listScriptKeybindings("s1")).toHaveLength(1);
    expect(listScriptKeybindings("s2")).toEqual([]);
  });

  it("lets a script REBIND its own combination (that is an update, not a theft)", () => {
    expect(bind({ combo: "Ctrl+Shift+K", handler: "first" }).result.ok).toBe(true);
    const again = bind({ combo: "Ctrl+Shift+K", handler: "second" });
    expect(again.result.ok).toBe(true);
    const held = listScriptKeybindings("s1");
    expect(held).toHaveLength(1);
    expect(held[0].handler).toBe("second");
  });

  it("caps one script at MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT", () => {
    const letters = "DGIJKMQTWYZ".split("");
    for (let i = 0; i < MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT; i++) {
      expect(bind({ combo: `Ctrl+Shift+${letters[i]}` }).result.ok, letters[i]).toBe(true);
    }
    const overflow = bind({ combo: `Ctrl+Shift+${letters[MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT]}` });
    expect(overflow.result.ok).toBe(false);
    if (overflow.result.ok) return;
    expect(overflow.result.code).toBe("limit");
    expect(listScriptKeybindings("s1")).toHaveLength(MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT);
  });

  it("lets the APP win a tie, so a late built-in cannot be shadowed by order", () => {
    // The script got there first (its registration was legal at the time). A
    // built-in claiming the same keys afterwards — a late-loading extension, a
    // user remap — must still win. Leaving this to Map insertion order is the
    // bug this rule replaces.
    const { run } = bind({ combo: "Ctrl+Shift+K" });
    const release = registerKeybinding({
      id: "core.late.feature",
      combo: "Ctrl+Shift+K",
      commandId: "core.late.feature",
      label: "Late feature",
      category: "Editing",
      source: "built-in",
    });
    // CommandRegistry.execute is what the dispatcher calls for a non-script
    // winner, so spying on it proves WHICH binding won.
    const executed = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined as never);
    try {
      expect(handleGlobalKeyDown(keydown({ key: "K", ctrlKey: true, shiftKey: true }))).toBe(true);
      expect(run, "the script won a tie against a built-in").not.toHaveBeenCalled();
      expect(executed).toHaveBeenCalledWith("core.late.feature");
    } finally {
      executed.mockRestore();
      release();
    }
  });
});

// ============================================================================
// 6. It fires, and it is told NOTHING but the combination
// ============================================================================

describe("pressing the keys", () => {
  it("runs the bound handler and consumes the event", () => {
    const { run } = bind({ combo: "Ctrl+Shift+R" });
    const event = keydown({ key: "R", ctrlKey: true, shiftKey: true });
    const prevented = vi.spyOn(event, "preventDefault");
    expect(handleGlobalKeyDown(event)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(prevented).toHaveBeenCalled();
  });

  it("hands over the combination and NOTHING else", () => {
    const { run } = bind({ combo: "Ctrl+Shift+R" });
    handleGlobalKeyDown(keydown({ key: "R", ctrlKey: true, shiftKey: true }));
    expect(run.mock.calls[0]).toEqual(["Ctrl+Shift+R"]);
    // Not the event, not a key, not a target: exactly one string argument.
    expect(run.mock.calls[0]).toHaveLength(1);
    expect(typeof run.mock.calls[0][0]).toBe("string");
  });

  it("wraps that combination as `{ combo }` on its way to the script", () => {
    // The runner the host installs is the only place a payload is built, and it
    // cannot be reached without a live worker realm — so the invariant is pinned
    // at the source. What must never appear here is a DOM event.
    const runner = HOST_SOURCE.slice(
      HOST_SOURCE.indexOf('case "cap.shortcutBind"'),
      HOST_SOURCE.indexOf('case "cap.shortcutUnbind"'),
    );
    expect(runner).toContain("hostCallExposed(objectType, boundInstanceId, handlerName, [{ combo: firedCombo }])");
    expect(runner).not.toMatch(/\bKeyboardEvent\b|\bevent\.\w/);
  });

  it("does NOT fire while the user is typing", () => {
    // A shortcut that fired into the formula bar or a dialog field would both
    // break text entry and turn a bound combination into a way to watch
    // somebody type. The context is host-set; a script cannot ask for "always".
    const { run } = bind({ combo: "Ctrl+Shift+R" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    try {
      expect(handleGlobalKeyDown(keydown({ key: "R", ctrlKey: true, shiftKey: true }))).toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("ignores a near-miss — no modifier soup reaches the handler", () => {
    const { run } = bind({ combo: "Ctrl+Shift+R" });
    for (const ev of [
      keydown({ key: "R" }),
      keydown({ key: "R", ctrlKey: true }),
      keydown({ key: "R", shiftKey: true }),
      keydown({ key: "R", ctrlKey: true, shiftKey: true, altKey: true }),
      keydown({ key: "T", ctrlKey: true, shiftKey: true }),
    ]) {
      handleGlobalKeyDown(ev);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 7. Visible, revocable, and gone when the script is
// ============================================================================

describe("a script shortcut is never invisible and never ambient", () => {
  it("is listed with its owner, its keys and the method it calls", () => {
    bind({ combo: "Ctrl+Shift+R", label: "Refresh all figures" });
    const listed = listScriptKeybindings();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      combo: "Ctrl+Shift+R",
      scriptId: "s1",
      scriptName: "Quarterly close",
      handler: "refreshAll",
      label: "Refresh all figures",
    });
  });

  it("appears in the shortcut list the user already has, attributed to the script", () => {
    bind({ combo: "Ctrl+Shift+R" });
    const row = getAllKeybindings().find((b) => b.combo === "Ctrl+Shift+R");
    expect(row).toBeDefined();
    expect(row!.source).toBe("script");
    expect(row!.scriptId).toBe("s1");
    // Attribution is HOST-supplied: a script shortcut can never present itself
    // as a built-in.
    expect(row!.category).toBe("Quarterly close");
    // And it carries no command id, so nothing that can execute commands can
    // reach the script's method through the command registry.
    expect(row!.commandId).toBe("");
  });

  it("defaults its label to the method it calls, so a blank label still says something", () => {
    bind({ combo: "Ctrl+Shift+R" });
    expect(listScriptKeybindings("s1")[0].label).toBe("refreshAll()");
  });

  it("can be taken back by the user, by the script, and by id", () => {
    const first = bind({ combo: "Ctrl+Shift+R" });
    expect(first.result.ok).toBe(true);
    if (!first.result.ok) return;
    expect(revokeScriptKeybinding(first.result.binding.id)).toBe(true);
    expect(listScriptKeybindings("s1")).toEqual([]);
    expect(getAllKeybindings().some((b) => b.combo === "Ctrl+Shift+R")).toBe(false);

    bind({ combo: "Ctrl+Shift+R" });
    expect(revokeScriptKeybindingCombo("s1", "ctrl+shift+r")).toBe(true);
    expect(revokeScriptKeybindingCombo("s1", "Ctrl+Shift+R")).toBe(false);
    expect(listScriptKeybindings("s1")).toEqual([]);
  });

  it("stops firing the moment it is revoked", () => {
    const { run } = bind({ combo: "Ctrl+Shift+R" });
    revokeScriptKeybindingsForScript("s1");
    expect(handleGlobalKeyDown(keydown({ key: "R", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("is released for the whole script at once — the unmount sweep", () => {
    bind({ combo: "Ctrl+Shift+R" });
    bind({ combo: "Ctrl+Shift+K" });
    bind({ scriptId: "s2", scriptName: "Other", combo: "Ctrl+Shift+J" });
    expect(revokeScriptKeybindingsForScript("s1")).toBe(2);
    expect(listScriptKeybindings("s1")).toEqual([]);
    // ...and only that script's.
    expect(listScriptKeybindings("s2")).toHaveLength(1);
  });

  it("is swept by unmount itself, not only by a per-binding cleanup", () => {
    // A shortcut that survived a failed cleanup list would be a key the user can
    // press to reach code that no longer exists. hostUnmountScript sweeps by
    // scriptId for exactly that reason.
    const unmount = HOST_SOURCE.slice(
      HOST_SOURCE.indexOf("export function hostUnmountScript"),
      HOST_SOURCE.indexOf("export function hostIsMounted"),
    );
    expect(unmount).toContain("revokeScriptKeybindingsForScript(scriptId)");
  });

  it("is not persisted and not remappable — it is a grant, not a preference", () => {
    const stored = () => window.localStorage.getItem("calcula.keybindings.custom");
    const before = stored();
    const first = bind({ combo: "Ctrl+Shift+R" });
    expect(first.result.ok).toBe(true);
    if (!first.result.ok) return;
    expect(stored()).toBe(before);

    // A stored override under an id that vanishes at unmount would be ambient
    // state outliving the code it belongs to, so the override is refused and the
    // effective combination stays the granted one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setUserKeybinding(first.result.binding.id, "Ctrl+Shift+Z");
    warn.mockRestore();
    expect(getEffectiveCombo(first.result.binding.id)).toBe("Ctrl+Shift+R");
    expect(window.localStorage.getItem("calcula.keybindings.overrides") ?? "").not.toContain(
      first.result.binding.id,
    );
  });
});

// ============================================================================
// 8. Without a grant, the broker denies — before the registry is ever touched
// ============================================================================

function handle(declared: string[]) {
  return buildHandleFromDefinition({
    id: "g2-script",
    name: "G2 test script",
    objectType: "workbook",
    instanceId: null,
    accessLevel: "restricted",
    declaredCapabilities: declared,
  });
}

describe("the broker denies a key hook without a grant", () => {
  beforeEach(() => {
    resetAllGrants();
  });

  it("denies with PermissionDenied when the script never DECLARED ui.shortcut", async () => {
    const h = handle([]);
    const executor = vi.fn();
    await expect(
      brokerCall(h, "cap.shortcutBind", ["Ctrl+Shift+R", "refreshAll"], executor as never),
    ).rejects.toMatchObject({ code: "PermissionDenied", capability: CAP });
    expect(executor).not.toHaveBeenCalled();
  });

  it("denies with CapabilityRequired when declared but not granted", async () => {
    const h = handle([CAP]);
    const executor = vi.fn();
    await expect(
      brokerCall(h, "cap.shortcutBind", ["Ctrl+Shift+R", "refreshAll"], executor as never),
    ).rejects.toMatchObject({ code: "CapabilityRequired", capability: CAP });
    // The executor is what touches the registry. Nothing may be bound behind a
    // denial.
    expect(executor).not.toHaveBeenCalled();
    expect(listScriptKeybindings("g2-script")).toEqual([]);
  });

  it("validates the arguments before the capability check", async () => {
    const h = handle([CAP]);
    const executor = vi.fn();
    await expect(
      brokerCall(h, "cap.shortcutBind", [""], executor as never),
    ).rejects.toMatchObject({ code: "ValidationError" });
    expect(executor).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 9. Every binding lands in the workbook audit log
// ============================================================================
//
// A shortcut appears in the live shortcut list — but only while the script is
// mounted. The audit is what lets a user ask, afterwards, "did anything in this
// workbook take a key on my keyboard?". An unaudited capability call would break
// exactly the promise the transparency panel makes.

describe("taking a shortcut is audited", () => {
  beforeEach(() => {
    resetAllGrants();
    invokeBackend.mockClear();
  });

  it("persists a successful bind, with the capability named", async () => {
    const h = handle([CAP]);
    recordCapabilityGrant("g2-script", CAP as never);
    await brokerCall(h, "cap.shortcutBind", ["Ctrl+Shift+R", "refreshAll"], async () => ({}));
    expect(invokeBackend).toHaveBeenCalledWith(
      "audit_record_capability",
      expect.objectContaining({ scriptId: "g2-script", capability: CAP, ok: true }),
    );
  });

  it("persists a DENIAL too — an attempt to take a key is as interesting as a success", async () => {
    const h = handle([CAP]);
    await expect(
      brokerCall(h, "cap.shortcutBind", ["Ctrl+Shift+R", "refreshAll"], async () => ({})),
    ).rejects.toMatchObject({ code: "CapabilityRequired" });
    expect(invokeBackend).toHaveBeenCalledWith(
      "audit_record_capability",
      expect.objectContaining({ scriptId: "g2-script", capability: CAP, ok: false }),
    );
  });
});
