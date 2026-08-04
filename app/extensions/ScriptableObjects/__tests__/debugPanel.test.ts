//! FILENAME: app/extensions/ScriptableObjects/__tests__/debugPanel.test.ts
// PURPOSE: The gutter must be HONEST. A solid dot means "execution will stop
//          here"; anything else must be visibly different and must say why. A
//          breakpoint that looks armed and never fires is the single worst bug
//          a debugger UI can have.

import { describe, it, expect } from "vitest";
import {
  badgeClassFor,
  breakpointShift,
  computeDebugDecorations,
  idleMessage,
  statusLabel,
} from "../components/DebugPanel";
import type { DebugSessionState, DebugTrigger } from "../lib/debugger";

/** A real event hook: something in the app fires it. */
const HOOK_TRIGGER: DebugTrigger = {
  id: "hook:onClick",
  kind: "hook",
  name: "onClick",
  description: "a click on it (the button this script is attached to)",
  fireable: true,
};

/** A run-target: only the USER can start it. Never a reason to say "waiting". */
const RUN_TARGET: DebugTrigger = {
  id: "method:monthlyClose",
  kind: "method",
  name: "monthlyClose",
  description: "run monthlyClose() from the top",
  fireable: true,
  runTarget: true,
};

function session(partial: Partial<DebugSessionState>): DebugSessionState {
  return {
    scriptId: "s1",
    scriptName: "Test",
    status: "running",
    // The object-script default: the mount called setup. A module macro's
    // session is the false case, and the tests below name it explicitly.
    autoInvokeSetup: true,
    breakpoints: [],
    ready: null,
    paused: null,
    lastSnapshot: null,
    activity: null,
    lastActivity: null,
    triggers: [],
    error: null,
    ...partial,
  };
}

describe("gutter decorations", () => {
  it("shows breakpoints as not-yet-armed before a session exists", () => {
    const [d] = computeDebugDecorations([4], null);
    expect(d.glyphClassName).toBe("breakpoint-glyph");
    expect(d.hover).toMatch(/Start debugging/);
  });

  it("marks a breakpoint on a pausable line as armed", () => {
    const s = session({
      ready: { instrumented: true, pausableLines: [4], snapshotLines: [], promotedFunctions: [] },
    });
    const [d] = computeDebugDecorations([4], s);
    expect(d.glyphClassName).toBe("breakpoint-glyph");
    expect(d.hover).toMatch(/will pause/);
  });

  it("marks a breakpoint in a SYNCHRONOUS function as unverified, and says why", () => {
    const s = session({
      ready: { instrumented: true, pausableLines: [], snapshotLines: [9], promotedFunctions: [] },
    });
    const [d] = computeDebugDecorations([9], s);
    expect(d.glyphClassName).toBe("breakpoint-glyph-unverified");
    expect(d.hover).toMatch(/SYNCHRONOUS/);
    expect(d.hover).toMatch(/async/);
  });

  it("marks a breakpoint on a line with no statement as unverified", () => {
    const s = session({
      ready: { instrumented: true, pausableLines: [2], snapshotLines: [], promotedFunctions: [] },
    });
    const [d] = computeDebugDecorations([7], s);
    expect(d.glyphClassName).toBe("breakpoint-glyph-unverified");
    expect(d.hover).toMatch(/No statement starts on line 7/);
  });

  it("adds a distinct paused-line marker", () => {
    const s = session({
      status: "paused",
      ready: { instrumented: true, pausableLines: [4], snapshotLines: [], promotedFunctions: [] },
      paused: { line: 4, reason: "breakpoint", variables: [], callStack: [], waiting: 0 },
    });
    const decos = computeDebugDecorations([4], s);
    const pausedMarker = decos.find((d) => d.glyphClassName === "debug-paused-glyph");
    expect(pausedMarker?.line).toBe(4);
    expect(pausedMarker?.lineClassName).toBe("debug-paused-line");
  });
});

describe("the status badge must never claim work is happening", () => {
  it("says WAITING and NAMES THE HOOK for a script that is idle between triggers", () => {
    const s = session({ status: "waiting", triggers: [HOOK_TRIGGER] });
    expect(statusLabel(s)).toBe("Waiting for onClick");
    expect(statusLabel(s)).not.toMatch(/running/i);
  });

  it("names both hooks when there are two, and counts them beyond that", () => {
    const onEdit: DebugTrigger = { ...HOOK_TRIGGER, id: "hook:onEdit", name: "onEdit" };
    const onSave: DebugTrigger = { ...HOOK_TRIGGER, id: "hook:onBeforeSave", name: "onBeforeSave" };
    expect(statusLabel(session({ status: "waiting", triggers: [HOOK_TRIGGER, onEdit] }))).toBe(
      "Waiting for onClick or onEdit",
    );
    expect(
      statusLabel(session({ status: "waiting", triggers: [HOOK_TRIGGER, onEdit, onSave] })),
    ).toBe("Waiting for one of its 3 event hooks");
  });

  it("says FINISHED for a script that ran to completion with nothing to restart it", () => {
    expect(statusLabel(session({ status: "finished", lastActivity: { label: "setup" } }))).toBe(
      "Finished",
    );
  });

  it("says so when the last run THREW, instead of a serene Finished", () => {
    const s = session({
      status: "finished",
      lastActivity: { label: "monthlyClose()", error: "TypeError: x is not a function" },
    });
    expect(statusLabel(s)).toBe("Finished with an error");
  });

  it("NAMES what is running while something really is", () => {
    const s = session({ status: "running", activity: { label: "onClick" } });
    expect(statusLabel(s)).toBe("Running onClick");
  });

  it("falls back to a bare Running when the realm did not name the execution", () => {
    expect(statusLabel(session({ status: "running" }))).toBe("Running");
  });

  it("says setup() failed rather than pretending the session is live", () => {
    const s = session({ status: "failed", error: "button is not defined" });
    expect(statusLabel(s)).toBe("setup() failed");
  });

  it("still reports the paused line", () => {
    const s = session({
      status: "paused",
      paused: { line: 12, reason: "breakpoint", variables: [], callStack: [], waiting: 0 },
    });
    expect(statusLabel(s)).toBe("Paused — line 12");
  });
});

// ============================================================================
// An INERT mount (a module macro) executed NOTHING when the session opened, so
// the badge must not say "Paused — line N" (which is what the mount-time
// execution used to produce), must not say "Running", and must not claim
// "setup() finished" either. It says the script is ready and nothing has run.
// ============================================================================

describe("the badge after an inert mount", () => {
  it("says nothing has run yet — not Paused, not Running, not Waiting-for-a-trigger", () => {
    // The host's status for a prepared macro is "finished" (its run-targets are
    // not things that WILL fire), but nothing has run, so the word is Ready.
    const s = session({
      status: "finished",
      autoInvokeSetup: false,
      triggers: [RUN_TARGET],
    });
    expect(statusLabel(s)).toBe("Ready — nothing has run yet");
    expect(statusLabel(s)).not.toMatch(/paused|running|waiting/i);
    // ...and it is not greyed out like a spent session: pressing Run is the
    // next thing to do.
    expect(badgeClassFor(s)).toBe("waiting");
  });

  it("says FINISHED — never 'waiting' — once the macro HAS run", () => {
    const s = session({
      status: "finished",
      autoInvokeSetup: false,
      triggers: [RUN_TARGET],
      lastActivity: { label: "monthlyClose()", durationMs: 420 },
    });
    // THE REPORTED BUG: this used to be "Waiting for a trigger", forever,
    // because the macro's own run-target counted as something to wait for.
    expect(statusLabel(s)).toBe("Finished");
    expect(badgeClassFor(s)).toBe("finished");
  });

  it("says NOTHING TO RUN — not 'setup() failed' — when an inert mount has no run target", () => {
    const s = session({
      status: "failed",
      autoInvokeSetup: false,
      error: "no top-level function declaration was found",
    });
    expect(statusLabel(s)).toBe("Nothing to run");
  });

  it("leaves the object-script wording alone (the scope guard)", () => {
    const s = session({ status: "waiting", autoInvokeSetup: true, triggers: [HOOK_TRIGGER] });
    expect(statusLabel(s)).toBe("Waiting for onClick");
  });
});

// ============================================================================
// The panel's sentence under the badge. Same rule, more words: it may only
// promise an arrival when a real event HOOK exists.
// ============================================================================

describe("the idle explanation", () => {
  it("promises an arrival only when a hook can arrive", () => {
    const withHook = session({
      status: "waiting",
      triggers: [HOOK_TRIGGER],
      lastActivity: { label: "onClick" },
    });
    expect(idleMessage(withHook)).toMatch(/runs again when onClick fires/);

    const runTargetOnly = session({
      status: "finished",
      autoInvokeSetup: false,
      triggers: [RUN_TARGET],
      lastActivity: { label: "monthlyClose()", durationMs: 1500 },
    });
    const text = idleMessage(runTargetOnly);
    expect(text).toMatch(/^Finished\./);
    expect(text).toMatch(/No event hook can start this script again/);
    expect(text).toMatch(/in 1\.5 s/);
    expect(text).not.toMatch(/waiting|fires/i);
  });

  it("keeps the prepared-but-unrun wording for a macro that has not started", () => {
    const s = session({ status: "finished", autoInvokeSetup: false, triggers: [RUN_TARGET] });
    expect(idleMessage(s)).toMatch(/nothing has run yet/i);
    expect(idleMessage(s)).not.toMatch(/Finished/);
  });

  it("leads with the error when the last run threw, and says why the session is still here", () => {
    const s = session({
      status: "finished",
      autoInvokeSetup: false,
      triggers: [RUN_TARGET],
      lastActivity: { label: "monthlyClose()", error: "TypeError: x is not a function" },
    });
    const text = idleMessage(s);
    expect(text).toMatch(/monthlyClose\(\) stopped with an error: TypeError/);
    expect(text).toMatch(/kept open/);
  });

  it("does not claim an object script registered nothing when it exposed methods", () => {
    const exposed: DebugTrigger = { ...RUN_TARGET, runTarget: undefined, name: "recalcAll" };
    const s = session({ status: "finished", triggers: [exposed] });
    expect(idleMessage(s)).toMatch(/registered no event hook/);
    expect(idleMessage(s)).toMatch(/exposed method/);
  });
});

describe("breakpoint re-anchoring", () => {
  it("reports the shift for an inserted line", () => {
    expect(breakpointShift({ range: { startLineNumber: 5, endLineNumber: 5 }, text: "\n" })).toEqual({
      fromLine: 6,
      delta: 1,
    });
  });

  it("reports the shift for a multi-line paste", () => {
    expect(
      breakpointShift({ range: { startLineNumber: 2, endLineNumber: 2 }, text: "a\nb\nc" }),
    ).toEqual({ fromLine: 3, delta: 2 });
  });

  it("reports a negative shift for deleted lines", () => {
    expect(breakpointShift({ range: { startLineNumber: 3, endLineNumber: 6 }, text: "" })).toEqual({
      fromLine: 4,
      delta: -3,
    });
  });

  it("ignores an edit within one line", () => {
    expect(
      breakpointShift({ range: { startLineNumber: 3, endLineNumber: 3 }, text: "hello" }),
    ).toBeNull();
  });
});
